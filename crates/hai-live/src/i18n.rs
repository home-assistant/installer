//! Text in the user's language, from the catalogs in `locales/` that `build.rs` compiles in.
//!
//! Messages use the part of ICU MessageFormat the desktop installer uses: `{name}`, and
//! `{name, plural, =0 {…} one {…} other {…}}` with `#` for the number. Apostrophes quote like
//! intl-messageformat's: `''` is one, `'{` starts quoted text, and "Can't" stays as it is. A
//! translation that lacks a message, leaves it empty or breaks it shows the English instead.

use std::fmt::{self, Display};

use icu_locale_core::LanguageIdentifier;
use icu_plurals::{PluralCategory, PluralRules};

/// One language's messages, sorted by key.
struct Catalog {
    tag: &'static str,
    messages: &'static [(&'static str, &'static str)],
}

/// Every catalog in `locales/`, English first.
static CATALOGS: &[Catalog] = include!(concat!(env!("OUT_DIR"), "/catalogs.rs"));

/// The values of a message's placeholders, by name. A plural's value must be a whole number.
pub type Args<'a> = [(&'a str, &'a dyn Display)];

/// A language hai-live can show.
#[derive(Clone, Copy)]
pub struct Language(&'static Catalog);

impl Language {
    /// The source language, which every other one falls back to.
    pub fn english() -> Self {
        Self(&CATALOGS[0])
    }

    /// The catalog for the BCP 47 `tag`: the exact one, else the one with trailing subtags
    /// dropped (`de-AT` gets `de`), else English.
    pub fn for_tag(mut tag: &str) -> Self {
        loop {
            if let Some(catalog) = CATALOGS.iter().find(|c| c.tag.eq_ignore_ascii_case(tag)) {
                return Self(catalog);
            }
            match tag.rsplit_once('-') {
                Some((shorter, _)) => tag = shorter,
                None => return Self::english(),
            }
        }
    }

    /// Every compiled language, sorted by its own name.
    pub fn all() -> Vec<Self> {
        let mut all: Vec<Self> = CATALOGS.iter().map(Self).collect();
        all.sort_by_cached_key(|language| sort_key(language.name()));
        all
    }

    /// The tag the catalog is named after, like `de` for `de.json`.
    #[cfg(test)]
    pub fn tag(self) -> &'static str {
        self.0.tag
    }

    /// The language's name in itself, like "Deutsch".
    pub fn name(self) -> String {
        self.text("live.language_name")
    }

    /// English, or a regional English.
    pub fn is_english(self) -> bool {
        self.0.tag.split('-').next() == Some("en")
    }

    /// The messages as the catalog has them, sorted by key, for tests that check them all.
    #[cfg(test)]
    pub fn messages(self) -> &'static [(&'static str, &'static str)] {
        self.0.messages
    }

    /// The message `key`, which has no placeholders.
    pub fn text(self, key: &str) -> String {
        self.format(key, &[])
    }

    /// The message `key` with its placeholders filled in from `args`.
    pub fn format(self, key: &str, args: &Args) -> String {
        self.segments(key, args)
            .into_iter()
            .map(|segment| segment.text)
            .collect()
    }

    /// The message `key` like [`Self::format`], in segments, so that the placeholders' values
    /// can be styled.
    pub fn segments(self, key: &str, args: &Args) -> Vec<Segment<'static>> {
        let translated = self
            .message(key)
            .filter(|message| !message.trim().is_empty());
        if let Some(segments) = translated.and_then(|message| format(message, self.0.tag, args)) {
            return segments;
        }
        let english = Self::english();
        let message = english.message(key);
        let segments = message.and_then(|message| format(message, english.0.tag, args));
        debug_assert!(
            segments.is_some(),
            "{key} can't be shown with {} values",
            args.len()
        );
        segments.unwrap_or_else(|| {
            vec![Segment {
                text: message.unwrap_or(key).to_string(),
                placeholder: None,
            }]
        })
    }

    fn message(self, key: &str) -> Option<&'static str> {
        let messages = self.0.messages;
        let index = messages.binary_search_by_key(&key, |&(key, _)| key).ok()?;
        Some(messages[index].1)
    }
}

/// The accented Latin letters the console font has, over the letters they sort as.
const ACCENTS: [&str; 2] = [
    "àáâãäåçèéêëìíîïñòóôõöøùúûüýÿāăąćčďđēėęěğģħĩīįķĺļľŀłńņňōőŕŗřśşšţťũūůűųŵźżžșțȳẽỹ",
    "aaaaaaceeeeiiiinoooooouuuuyyaaaccddeeeegghiiiklllllnnnoorrrsssttuuuuuwzzzstyey",
];

/// What a language's `name` sorts by: lowercased and without accents, so that "Čeština" comes
/// before "Deutsch" and not after "Türkçe", then the name as it is.
fn sort_key(name: String) -> (String, String) {
    let [accented, plain] = ACCENTS;
    let folded = name
        .to_lowercase()
        .chars()
        .map(|c| {
            let mut pairs = accented.chars().zip(plain.chars());
            pairs.find(|&(a, _)| a == c).map_or(c, |(_, p)| p)
        })
        .collect();
    (folded, name)
}

impl PartialEq for Language {
    fn eq(&self, other: &Self) -> bool {
        self.0.tag == other.0.tag
    }
}

impl Eq for Language {}

impl fmt::Debug for Language {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str(self.0.tag)
    }
}

/// A run of a formatted message: its own text, or the value of one placeholder.
#[derive(Debug, PartialEq, Eq)]
pub struct Segment<'m> {
    pub text: String,
    /// The placeholder that `text` is the value of.
    pub placeholder: Option<&'m str>,
}

/// A message, parsed.
enum Node<'m> {
    Text(String),
    /// `{name}`
    Value(&'m str),
    /// `{name, plural, …}`: each branch's selector (`=0`, `one`, `other`, …) and content.
    Plural(&'m str, Vec<(&'m str, Vec<Node<'m>>)>),
    /// `#` in a plural branch: the number.
    Number,
}

/// `message` with its placeholders filled in, choosing plurals by the rules of the language
/// `tag`. `None` when the message is broken or `args` lacks a value it needs.
fn format<'m>(message: &'m str, tag: &str, args: &Args) -> Option<Vec<Segment<'m>>> {
    let nodes = parse(message)?;
    let mut segments = Vec::new();
    write(&nodes, tag, args, None, &mut segments)?;
    Some(segments)
}

fn write<'m>(
    nodes: &[Node<'m>],
    tag: &str,
    args: &Args,
    number: Option<&str>,
    out: &mut Vec<Segment<'m>>,
) -> Option<()> {
    for node in nodes {
        match node {
            Node::Text(text) => push_text(out, text),
            Node::Number => push_text(out, number?),
            Node::Value(name) => out.push(Segment {
                text: value(args, name)?,
                placeholder: Some(*name),
            }),
            Node::Plural(name, branches) => {
                let value = value(args, name)?;
                let branch = branch(branches, value.parse().ok()?, tag)?;
                write(branch, tag, args, Some(&value), out)?;
            }
        }
    }
    Some(())
}

fn value(args: &Args, name: &str) -> Option<String> {
    let (_, value) = args.iter().find(|(arg, _)| *arg == name)?;
    Some(value.to_string())
}

/// Adds the message's own text, joined to any text right before it.
fn push_text(out: &mut Vec<Segment>, text: &str) {
    match out.last_mut() {
        Some(last) if last.placeholder.is_none() => last.text.push_str(text),
        _ => out.push(Segment {
            text: text.to_string(),
            placeholder: None,
        }),
    }
}

/// The plural branch for `n`: `=n`, else the one for its plural category, else `other`.
fn branch<'a, 'm>(
    branches: &'a [(&'m str, Vec<Node<'m>>)],
    n: u64,
    tag: &str,
) -> Option<&'a [Node<'m>]> {
    let find = |matches: &dyn Fn(&str) -> bool| {
        branches
            .iter()
            .find(|(selector, _)| matches(selector))
            .map(|(_, nodes)| nodes.as_slice())
    };
    find(&|selector| selector.strip_prefix('=').and_then(|s| s.parse().ok()) == Some(n))
        .or_else(|| {
            let category = plural_category(tag, n);
            find(&|selector| PluralCategory::get_for_cldr_string(selector) == Some(category))
        })
        .or_else(|| find(&|selector| selector == "other"))
}

fn plural_category(tag: &str, n: u64) -> PluralCategory {
    plural_rules(tag).map_or(PluralCategory::Other, |rules| rules.category_for(n))
}

/// The cardinal plural rules of the language `tag`.
fn plural_rules(tag: &str) -> Option<PluralRules> {
    let mut language = LanguageIdentifier::try_from_str(tag).ok()?;
    // CLDR's rules don't depend on the script, but ICU4X takes sr-Latn's from root, where every
    // number is `other`. The region stays: pt-PT's differ from pt's.
    language.script = None;
    PluralRules::try_new_cardinal((&language).into()).ok()
}

/// Parses `message`, or `None` where it isn't valid.
fn parse(message: &str) -> Option<Vec<Node<'_>>> {
    Parser { message, at: 0 }.nodes(false)
}

struct Parser<'m> {
    message: &'m str,
    /// Byte offset of the next character.
    at: usize,
}

impl<'m> Parser<'m> {
    fn peek(&self) -> Option<char> {
        self.message[self.at..].chars().next()
    }

    fn next(&mut self) -> Option<char> {
        let c = self.peek()?;
        self.at += c.len_utf8();
        Some(c)
    }

    fn eat(&mut self, c: char) -> bool {
        let found = self.peek() == Some(c);
        if found {
            self.at += c.len_utf8();
        }
        found
    }

    fn skip_spaces(&mut self) {
        while self.peek().is_some_and(char::is_whitespace) {
            self.next();
        }
    }

    /// A name or selector, without the spaces around it. Empty where there is none.
    fn word(&mut self) -> &'m str {
        self.skip_spaces();
        let start = self.at;
        while self
            .peek()
            .is_some_and(|c| !c.is_whitespace() && !"{},".contains(c))
        {
            self.next();
        }
        let word = &self.message[start..self.at];
        self.skip_spaces();
        word
    }

    /// Text and placeholders up to the end of the message, or of the plural branch they're in.
    fn nodes(&mut self, in_branch: bool) -> Option<Vec<Node<'m>>> {
        let mut nodes = Vec::new();
        let mut text = String::new();
        while let Some(c) = self.peek() {
            if c == '}' && in_branch {
                break;
            }
            self.next();
            let node = match c {
                '{' => self.placeholder()?,
                '#' if in_branch => Node::Number,
                '\'' => {
                    self.apostrophe(in_branch, &mut text);
                    continue;
                }
                _ => {
                    text.push(c);
                    continue;
                }
            };
            if !text.is_empty() {
                nodes.push(Node::Text(std::mem::take(&mut text)));
            }
            nodes.push(node);
        }
        if !text.is_empty() {
            nodes.push(Node::Text(text));
        }
        Some(nodes)
    }

    /// After a `'`: `''` is one apostrophe, and `'` before `{`, `}`, or `#` in a plural branch,
    /// quotes up to the next lone `'`. Any other `'` is itself.
    fn apostrophe(&mut self, in_branch: bool, text: &mut String) {
        match self.peek() {
            Some('\'') => {
                self.next();
                text.push('\'');
            }
            Some(c) if c == '{' || c == '}' || (c == '#' && in_branch) => {
                while let Some(c) = self.next() {
                    if c != '\'' {
                        text.push(c);
                    } else if self.eat('\'') {
                        text.push('\'');
                    } else {
                        break;
                    }
                }
            }
            _ => text.push('\''),
        }
    }

    /// A placeholder, after its `{`.
    fn placeholder(&mut self) -> Option<Node<'m>> {
        let name = self.word();
        if name.is_empty() {
            return None;
        }
        if self.eat('}') {
            return Some(Node::Value(name));
        }
        if !self.eat(',') || self.word() != "plural" || !self.eat(',') {
            return None;
        }
        let mut branches = Vec::new();
        loop {
            let selector = self.word();
            if selector.is_empty() {
                // The plural's own `}`, unless the message ends first
                if !self.eat('}') {
                    return None;
                }
                break;
            }
            let valid = match selector.strip_prefix('=') {
                Some(n) => n.parse::<u64>().is_ok(),
                None => PluralCategory::get_for_cldr_string(selector).is_some(),
            };
            if !valid || !self.eat('{') {
                return None;
            }
            let nodes = self.nodes(true)?;
            if !self.eat('}') {
                return None;
            }
            branches.push((selector, nodes));
        }
        // ICU requires it: the branch for any number the others don't take
        let has_other = branches.iter().any(|(selector, _)| *selector == "other");
        has_other.then_some(Node::Plural(name, branches))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    use std::fs;
    use std::path::Path;

    fn formatted(message: &str, tag: &str, args: &Args) -> Option<String> {
        let segments = format(message, tag, args)?;
        Some(segments.into_iter().map(|segment| segment.text).collect())
    }

    fn en(message: &str, args: &Args) -> String {
        formatted(message, "en", args).unwrap_or_else(|| panic!("can't format {message}"))
    }

    /// Every placeholder in `nodes`: its name, and whether it's a plural.
    fn placeholders<'m>(nodes: &[Node<'m>], found: &mut BTreeSet<(&'m str, bool)>) {
        for node in nodes {
            match node {
                Node::Value(name) => {
                    found.insert((name, false));
                }
                Node::Plural(name, branches) => {
                    found.insert((name, true));
                    for (_, nodes) in branches {
                        placeholders(nodes, found);
                    }
                }
                Node::Text(_) | Node::Number => {}
            }
        }
    }

    /// The plural forms that `nodes` have a branch for, like `one`; not `=0`.
    fn plural_forms<'m>(nodes: &[Node<'m>], found: &mut BTreeSet<&'m str>) {
        for node in nodes {
            if let Node::Plural(_, branches) = node {
                for (selector, nodes) in branches {
                    if !selector.starts_with('=') {
                        found.insert(*selector);
                    }
                    plural_forms(nodes, found);
                }
            }
        }
    }

    #[test]
    fn fills_in_placeholders() {
        assert_eq!(
            en(
                "Could not open {disk}: {error}",
                &[("disk", &"sda"), ("error", &"Device busy")]
            ),
            "Could not open sda: Device busy"
        );
        assert_eq!(
            en("{ os } will be written", &[("os", &"HAOS")]),
            "HAOS will be written"
        );
        // A value the message needs but isn't given
        assert_eq!(formatted("Could not open {disk}", "en", &[]), None);
    }

    #[test]
    fn splits_at_placeholder_values() {
        let segments = format("Open {url} in a browser.", "en", &[("url", &"http://x")]);
        let text = |text: &str| text.to_string();
        assert_eq!(
            segments.unwrap(),
            [
                Segment {
                    text: text("Open "),
                    placeholder: None
                },
                Segment {
                    text: text("http://x"),
                    placeholder: Some("url")
                },
                Segment {
                    text: text(" in a browser."),
                    placeholder: None
                },
            ]
        );
    }

    #[test]
    fn chooses_plurals_by_the_rules_of_the_language() {
        let minutes = "About {minutes, plural, =0 {no time} one {# minute} other {# minutes}} left";
        let left = |n: u64| en(minutes, &[("minutes", &n)]);
        assert_eq!(left(0), "About no time left");
        assert_eq!(left(1), "About 1 minute left");
        assert_eq!(left(3), "About 3 minutes left");

        let devices = "{reason}: {count, plural, one {# Gerät ({reason})} other {# Geräte}}";
        let de = |n: u64| formatted(devices, "de", &[("reason", &"RAM-Disk"), ("count", &n)]);
        assert_eq!(de(1).as_deref(), Some("RAM-Disk: 1 Gerät (RAM-Disk)"));
        assert_eq!(de(16).as_deref(), Some("RAM-Disk: 16 Geräte"));

        // Polish has more forms than English and German
        let files = "{n, plural, one {# plik} few {# pliki} many {# plików} other {# pliku}}";
        let pl = |n: u64| formatted(files, "pl", &[("n", &n)]);
        assert_eq!(pl(2).as_deref(), Some("2 pliki"));
        assert_eq!(pl(5).as_deref(), Some("5 plików"));
        // Without its form, a number takes `other`
        assert_eq!(
            en("{n, plural, other {# things}}", &[("n", &1)]),
            "1 things"
        );
        assert_eq!(formatted(files, "pl", &[("n", &"many")]), None);

        // Serbian has the same rules in either script
        assert_eq!(plural_category("sr-Latn", 2), PluralCategory::Few);
        // Portugal's Portuguese doesn't count 0 as one, Brazil's does
        assert_eq!(plural_category("pt", 0), PluralCategory::One);
        assert_eq!(plural_category("pt-PT", 0), PluralCategory::Other);
    }

    #[test]
    fn sorts_language_names_by_their_letters_not_their_accents() {
        let [accented, plain] = ACCENTS;
        assert_eq!(accented.chars().count(), plain.chars().count());
        let mut names = [
            "Türkçe",
            "Íslenska",
            "Čeština",
            "Català",
            "Deutsch",
            "English",
            "Ελληνικά",
            "Русский",
        ]
        .map(String::from);
        names.sort_by_cached_key(|name| sort_key(name.clone()));
        assert_eq!(
            names,
            [
                "Català",
                "Čeština",
                "Deutsch",
                "English",
                "Íslenska",
                "Türkçe",
                "Ελληνικά",
                "Русский"
            ]
        );
    }

    #[test]
    fn apostrophes_work_like_intl_messageformat() {
        assert_eq!(
            en("Can't be used: {problem}", &[("problem", &"x")]),
            "Can't be used: x"
        );
        assert_eq!(en("It''s '{name}' and '{'", &[]), "It's {name} and {");
        assert_eq!(en("'{it''s}' {name}", &[("name", &"x")]), "{it's} x");
        // `'#` quotes only in a plural branch, where # is the number
        assert_eq!(
            en("'#1 {n, plural, other {'#' is #}}", &[("n", &3)]),
            "'#1 # is 3"
        );
        // A `}` outside a placeholder is text, like in intl-messageformat
        assert_eq!(en("a } b", &[]), "a } b");
    }

    #[test]
    fn rejects_broken_messages() {
        for broken in [
            "{disk",
            "{}",
            "{disk, number}",
            "{n, select, other {x}}",
            "{n, plural, one {# disk}}",
            "{n, plural, one {# disk} other {# disks}",
            "{n, plural, sometimes {#} other {#}}",
            "{n, plural, =x {#} other {#}}",
        ] {
            assert!(parse(broken).is_none(), "{broken}");
        }
    }

    #[test]
    fn a_missing_empty_or_broken_translation_shows_the_english() {
        static GERMAN: Catalog = Catalog {
            tag: "de",
            messages: &[
                ("live.ui.confirm.os", "{os wird darauf geschrieben."),
                ("live.ui.confirm.title", " "),
                ("live.ui.confirm.warning", "Alles darauf wird gelöscht."),
                (
                    "live.ui.done.installed",
                    "Home Assistant OS ist auf {drive}.",
                ),
            ],
        };
        let german = Language(&GERMAN);
        assert_eq!(
            german.text("live.ui.confirm.warning"),
            "Alles darauf wird gelöscht."
        );
        assert_eq!(
            german.format("live.ui.confirm.os", &[("os", &"HAOS")]),
            "HAOS will be written to it."
        );
        assert_eq!(german.text("live.ui.confirm.title"), "Erase this disk?");
        assert_eq!(german.text("live.ui.keys.back"), "back");
        assert_eq!(
            german.format("live.ui.done.installed", &[("disk", &"sda")]),
            "Home Assistant OS is on sda."
        );
    }

    #[test]
    fn finds_the_nearest_catalog_for_a_tag() {
        // qaa (private use) and the region ZZ (unknown) never get a catalog
        for (tag, expected) in [
            ("de", "de"),
            ("de-ZZ", "de"),
            ("DE-zz", "de"),
            ("de-Latn-ZZ", "de"),
            ("en-ZZ", "en"),
            ("qaa", "en"),
            ("deutsch", "en"),
            ("", "en"),
        ] {
            assert_eq!(Language::for_tag(tag).tag(), expected, "{tag}");
        }
    }

    #[test]
    fn every_translation_fits_the_english() {
        let english = Language::english();
        let mut names = BTreeSet::new();
        for language in Language::all() {
            let tag = language.tag();
            let canonical = LanguageIdentifier::try_from_str(tag).map(|id| id.to_string());
            assert_eq!(
                canonical.ok().as_deref(),
                Some(tag),
                "{tag}.json: name it after its tag"
            );
            let name = language.message("live.language_name").unwrap_or_default();
            assert!(
                !name.trim().is_empty(),
                "{tag}.json: needs live.language_name"
            );
            assert!(
                names.insert(name),
                "{tag}.json: another language is called {name}"
            );
            for &(key, message) in language.messages() {
                let source = english.message(key);
                let source = source.unwrap_or_else(|| panic!("{tag}.json: unknown key {key}"));
                // An export can list untranslated keys with empty text
                if message.trim().is_empty() {
                    continue;
                }
                let nodes = parse(message);
                let nodes = nodes.unwrap_or_else(|| panic!("{tag}.json: {key} is broken"));
                let (mut found, mut expected) = (BTreeSet::new(), BTreeSet::new());
                placeholders(&nodes, &mut found);
                placeholders(&parse(source).unwrap(), &mut expected);
                // Like the frontend's check: a language without plural forms may write a plain
                // {minutes} where the English has a plural
                let names = |found: &BTreeSet<(&'static str, bool)>| {
                    found.iter().map(|&(name, _)| name).collect::<BTreeSet<_>>()
                };
                assert_eq!(
                    names(&found),
                    names(&expected),
                    "{tag}.json: {key} placeholder mismatch"
                );
                // A plural needs a number, and where the English keeps a placeholder plain the
                // code may pass text, which makes the message fall back to the English
                for &(name, plural) in &found {
                    assert!(
                        !plural || expected.contains(&(name, true)),
                        "{tag}.json: {key} makes {{{name}}} a plural, which the English doesn't"
                    );
                }
            }
        }
    }

    #[test]
    fn every_plural_form_is_one_the_language_has() {
        for language in Language::all() {
            let tag = language.tag();
            let has: Vec<PluralCategory> = plural_rules(tag)
                .map_or(vec![PluralCategory::Other], |rules| {
                    rules.categories().collect()
                });
            for &(key, message) in language.messages() {
                let mut forms = BTreeSet::new();
                plural_forms(&parse(message).unwrap_or_default(), &mut forms);
                for form in forms {
                    let category = PluralCategory::get_for_cldr_string(form);
                    assert!(
                        category.is_some_and(|category| has.contains(&category)),
                        "{tag}.json: {key} has a `{form}` form, which the plural rules for {tag} \
                         lack. If {tag} has it, plural_rules needs to map the tag to rules \
                         that do."
                    );
                }
            }
        }
    }

    /// The text of every `.rs` file in `folder` and the folders in it.
    fn rust_sources(folder: &Path, sources: &mut Vec<String>) {
        for entry in fs::read_dir(folder).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                rust_sources(&path, sources);
            } else if path.extension().is_some_and(|extension| extension == "rs") {
                sources.push(fs::read_to_string(&path).unwrap());
            }
        }
    }

    #[test]
    fn the_code_names_exactly_the_keys_of_en_json() {
        let mut sources = Vec::new();
        rust_sources(
            Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/src")),
            &mut sources,
        );
        let mut used = BTreeSet::new();
        for source in sources {
            // Only the code itself, not its tests
            let code = source.split("mod tests {").next().unwrap();
            for rest in code.split("\"live.").skip(1) {
                used.insert(format!("live.{}", rest.split('"').next().unwrap()));
            }
        }
        let keys: BTreeSet<String> = Language::english()
            .messages()
            .iter()
            .map(|(key, _)| key.to_string())
            .collect();
        let missing: Vec<_> = used.difference(&keys).collect();
        let unused: Vec<_> = keys.difference(&used).collect();
        assert!(
            missing.is_empty() && unused.is_empty(),
            "not in en.json: {missing:?}, not used: {unused:?}"
        );
    }
}
