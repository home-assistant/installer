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

use serde_json::Value;

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
}

impl std::fmt::Display for Message {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let Some(template) = catalog().get(self.key) else {
            return formatter.write_str(self.key);
        };

        // One pass over the template, so a value that contains `{name}` is
        // written as is instead of being filled in by a later parameter
        let mut rest = template.as_str();
        while let Some(start) = rest.find('{') {
            let Some(length) = rest[start..].find('}') else {
                break;
            };
            let placeholder = &rest[start..=start + length];
            let name = &placeholder[1..placeholder.len() - 1];

            formatter.write_str(&rest[..start])?;
            match self.params.iter().find(|(param, _)| *param == name) {
                Some((_, Value::String(text))) => formatter.write_str(text)?,
                Some((_, other)) => write!(formatter, "{other}")?,
                None => formatter.write_str(placeholder)?,
            }
            rest = &rest[start + placeholder.len()..];
        }
        formatter.write_str(rest)
    }
}

fn catalog() -> &'static HashMap<String, String> {
    static CATALOG: OnceLock<HashMap<String, String>> = OnceLock::new();
    CATALOG.get_or_init(|| {
        serde_json::from_str(include_str!("../../../src/localization/en.json"))
            .expect("en.json is a flat map of strings")
    })
}

/// The `{name}` placeholders in a catalog message.
#[cfg(any(debug_assertions, test))]
fn placeholders(template: &str) -> BTreeSet<&str> {
    template
        .split('{')
        .skip(1)
        .filter_map(|part| part.split_once('}').map(|(name, _)| name))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backend_messages_stay_simple() {
        // The English here is a plain substitution, so the catalog's backend
        // messages can't use ICU plurals, selects or quoting
        for (key, template) in catalog() {
            if !key.starts_with("backend.") {
                continue;
            }
            for name in placeholders(template) {
                assert!(
                    name.chars().all(|c| c.is_ascii_lowercase() || c == '_'),
                    "{key}: {{{name}}} is more than a plain placeholder"
                );
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
    #[should_panic(expected = "parameters don't match en.json")]
    fn wrong_parameters_are_caught() {
        crate::message!("backend.proxmox.node_offline", host = "pve");
    }
}
