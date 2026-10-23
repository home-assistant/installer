//! Text for the user, by its key in the frontend's message catalog.
//!
//! The English lives in `src/localization/en.json`, under `backend.`, next to
//! the frontend's own text, so there is one catalog to translate. Errors carry
//! the key and its parameters, and the frontend shows them in the user's
//! language. The English rendered here is for logs, and for a frontend that
//! doesn't know the key.

#[cfg(any(debug_assertions, test))]
use std::collections::BTreeSet;
use std::collections::HashMap;
use std::sync::OnceLock;

use serde::ser::{Serialize, SerializeMap, Serializer};
use serde_json::{Map, Value};

/// A catalog message with its parameters.
#[derive(Debug, Clone, PartialEq)]
pub struct Message {
    pub key: &'static str,
    pub params: Vec<(&'static str, Value)>,
}

/// Build a [`Message`]: `message!("backend.proxmox.node_offline", node = name)`.
#[macro_export]
macro_rules! message {
    ($key:literal $(, $name:ident = $value:expr)* $(,)?) => {
        $crate::message::Message::new(
            $key,
            vec![$((stringify!($name), $crate::serde_json::json!($value))),*],
        )
    };
}

impl Message {
    pub fn new(key: &'static str, params: Vec<(&'static str, Value)>) -> Self {
        // Every message a test reaches checks itself against the catalog,
        // release test runs included
        #[cfg(any(debug_assertions, test))]
        {
            let template = catalog()
                .get(key)
                .unwrap_or_else(|| panic!("{key} is missing from en.json"));
            let supplied: BTreeSet<&str> = params.iter().map(|(name, _)| *name).collect();
            assert_eq!(
                placeholders(template),
                supplied,
                "{key}: parameters don't match en.json"
            );
        }

        Self { key, params }
    }

    /// The parameters as a JSON object, the way the frontend receives them.
    pub fn params_json(&self) -> Map<String, Value> {
        self.params
            .iter()
            .map(|(name, value)| (name.to_string(), value.clone()))
            .collect()
    }
}

/// A message can be a parameter of another one, like the reason a step
/// failed. It then travels as `{"key": ..., "params": {...}}`, so the
/// frontend translates both.
impl Serialize for Message {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(2))?;
        map.serialize_entry("key", self.key)?;
        map.serialize_entry("params", &self.params_json())?;
        map.end()
    }
}

impl std::fmt::Display for Message {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write_message(formatter, self.key, &|name| {
            self.params
                .iter()
                .find(|(param, _)| *param == name)
                .map(|(_, value)| value)
        })
    }
}

/// Fill in a catalog message in one pass, so a value that contains `{name}`
/// is written as is instead of being filled in by a later parameter.
fn write_message<'a>(
    formatter: &mut std::fmt::Formatter<'_>,
    key: &str,
    param: &dyn Fn(&str) -> Option<&'a Value>,
) -> std::fmt::Result {
    let Some(template) = catalog().get(key) else {
        return formatter.write_str(key);
    };

    let mut rest = template.as_str();
    while let Some((text, argument, after)) = split_argument(rest) {
        formatter.write_str(text)?;
        let mut parts = argument.splitn(3, ',').map(str::trim);
        let value = param(parts.next().unwrap_or_default());
        match (value, parts.next(), parts.next()) {
            (Some(value), Some("number"), style) => write!(formatter, "{value}{}", unit(style))?,
            (Some(value), Some("plural"), Some(branches)) => {
                formatter.write_str(&plural(branches, value).replace('#', &value.to_string()))?
            }
            (Some(Value::String(text)), ..) => formatter.write_str(text)?,
            (Some(value), ..) => match nested(value) {
                Some((key, params)) => write_message(formatter, key, &|name| params.get(name))?,
                None => write!(formatter, "{value}")?,
            },
            (None, ..) => write!(formatter, "{{{argument}}}")?,
        }
        rest = after;
    }
    formatter.write_str(rest)
}

/// The text before the first `{argument}`, the argument without its braces,
/// and the text after it. A plural's branches stay inside its argument.
fn split_argument(text: &str) -> Option<(&str, &str, &str)> {
    let start = text.find('{')?;
    let mut depth = 0;
    let end = start
        + text[start..].bytes().position(|byte| {
            match byte {
                b'{' => depth += 1,
                b'}' => depth -= 1,
                _ => {}
            }
            depth == 0
        })?;
    Some((&text[..start], &text[start + 1..end], &text[end + 1..]))
}

/// The English symbol of a number's unit skeleton, like `::unit/gigabyte`.
fn unit(style: Option<&str>) -> &'static str {
    match style {
        Some("::unit/gigabyte") => " GB",
        Some("::unit/megabyte") => " MB",
        _ => "",
    }
}

/// The English branch of a plural's `one {...} other {...}` for `count`.
fn plural<'a>(branches: &'a str, count: &Value) -> &'a str {
    let wanted = if *count == 1 { "one" } else { "other" };
    let mut rest = branches;
    while let Some((selector, branch, after)) = split_argument(rest) {
        if selector.trim() == wanted {
            return branch;
        }
        rest = after;
    }
    ""
}

/// The key and parameters of a message that is another message's parameter.
fn nested(value: &Value) -> Option<(&str, &Map<String, Value>)> {
    Some((
        value.get("key")?.as_str()?,
        value.get("params")?.as_object()?,
    ))
}

fn catalog() -> &'static HashMap<String, String> {
    static CATALOG: OnceLock<HashMap<String, String>> = OnceLock::new();
    CATALOG.get_or_init(|| {
        serde_json::from_str(include_str!("../../../src/localization/en.json"))
            .expect("en.json is a flat map of strings")
    })
}

/// The names of a catalog message's arguments, like `size` in `{size, number}`.
#[cfg(any(debug_assertions, test))]
fn placeholders(template: &str) -> BTreeSet<&str> {
    let mut names = BTreeSet::new();
    let mut rest = template;
    while let Some((_, argument, after)) = split_argument(rest) {
        names.insert(argument.split(',').next().unwrap_or_default().trim());
        rest = after;
    }
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backend_messages_stay_simple() {
        // The English here knows only plain placeholders, numbers in its
        // units and one/other plurals of plain text: no selects or quoting
        for (key, template) in catalog() {
            if !key.starts_with("backend.") {
                continue;
            }
            let mut rest = template.as_str();
            while let Some((_, argument, after)) = split_argument(rest) {
                let known = match argument.splitn(3, ", ").collect::<Vec<_>>()[..] {
                    [name] => name.chars().all(|c| c.is_ascii_lowercase() || c == '_'),
                    [_, "number"] => true,
                    [_, "number", style] => !unit(Some(style)).is_empty(),
                    [_, "plural", branches] => {
                        let (one, other) =
                            (plural(branches, &1.into()), plural(branches, &2.into()));
                        branches == format!("one {{{one}}} other {{{other}}}")
                            && !format!("{one}{other}").contains('{')
                    }
                    _ => false,
                };
                assert!(
                    known,
                    "{key}: {{{argument}}} is more than the English here knows"
                );
                rest = after;
            }
            // "can't" is fine, but an apostrophe before one of these quotes it
            for quoted in ["'{", "'}", "''", "'#", "'|"] {
                assert!(
                    !template.contains(quoted),
                    "{key}: {quoted} starts an ICU quote"
                );
            }
        }
    }

    #[test]
    fn renders_english_from_the_catalog() {
        let message = crate::message!("backend.proxmox.node_offline", node = "pve");
        assert_eq!(message.key, "backend.proxmox.node_offline");
        assert_eq!(
            message.to_string(),
            "Node \"pve\" is offline. Choose an online node or start it in Proxmox."
        );
    }

    #[test]
    fn renders_numbers_and_plurals_in_english() {
        let message = crate::message!(
            "backend.proxmox.storage_too_small",
            storage = "local-lvm",
            size_gb = 32,
            free_gb = 12,
        );
        assert_eq!(message.params_json()["size_gb"], 32);
        assert_eq!(
            message.to_string(),
            "Not enough free space on \"local-lvm\" for the 32 GB disk (12 GB free)."
        );
        for (minutes, wait) in [(1, "1 minute,"), (5, "5 minutes,")] {
            let message =
                crate::message!("backend.download.github_rate_limited", minutes = minutes);
            assert!(message.to_string().contains(wait), "{message}");
        }
    }

    #[test]
    fn values_are_not_filled_in_again() {
        let message = crate::message!(
            "backend.proxmox.leftover_import_image",
            volume = "local:import/{node}.qcow2",
            node = "pve",
        );
        assert!(message
            .to_string()
            .ends_with("Delete local:import/{node}.qcow2 from node pve in Proxmox."));
    }

    #[test]
    fn messages_nest_as_key_and_params() {
        let inner = crate::message!("backend.utm.applescript_lost", detail = "broken pipe");
        let message = crate::message!(
            "backend.utm.import_uncertain",
            detail = inner,
            path = "/tmp/image",
        );

        assert_eq!(
            message.params_json()["detail"],
            serde_json::json!({
                "key": "backend.utm.applescript_lost",
                "params": { "detail": "broken pipe" }
            })
        );
        assert!(message
            .to_string()
            .starts_with("UTM may still be importing the image: Failed to wait for AppleScript: broken pipe. Source retained at /tmp/image."));
    }

    #[test]
    #[should_panic(expected = "parameters don't match en.json")]
    fn wrong_parameters_are_caught() {
        crate::message!("backend.proxmox.node_offline", host = "pve");
    }
}
