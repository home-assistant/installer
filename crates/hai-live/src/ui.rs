//! Full-screen text interface on the Linux console: one centered card per step.
//!
//! Screens are plain data, drawn by [`render`], so they can be tested without a console. The
//! console's built-in font only has the old PC character set, so the drawing sticks to its
//! straight box lines, blocks and arrows.

use std::io::{self, Stdout, Write};
use std::time::Duration;

use ratatui::backend::CrosstermBackend;
use ratatui::crossterm::event::{self, Event, KeyCode, KeyEventKind};
use ratatui::crossterm::{cursor, execute, terminal};
use ratatui::layout::{Constraint, Flex, Layout};
use ratatui::style::{Color, Style, Stylize};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Padding, Paragraph, Wrap};
use ratatui::{Frame, Terminal};

use crate::i18n::{Args, Language};
use crate::safety::{Hidden, Problem};

/// Accent color. On the Linux console, palette entries 4 and 12 are set to Home Assistant blue:
/// the console shows bold blue text in its bright blue, entry 12.
const ACCENT: Color = Color::Blue;
const MUTED: Color = Color::DarkGray;
/// The bright yellow: plain yellow is brown on the Linux console.
const WARNING: Color = Color::LightYellow;

/// Where Home Assistant opens once it has started.
const HOME_ASSISTANT_URL: &str = "http://homeassistant.local";

/// Widest the card gets, so lines stay easy to read on large consoles.
const CARD_WIDTH: u16 = 80;

/// The Home Assistant mark in half blocks: each character is two pixels, top and bottom.
/// Rendered from the mark's SVG at 32 pixels; the gaps are the tree.
const LOGO: [&str; 13] = [
    "           ▄██▄",
    "         ▄██████▄",
    "       ▄██████████▄",
    "     ▄█████▀  ▀█████▄",
    "   ▄███████    ███████▄",
    " ▄██████████  ██████████▄",
    "████████████  ████▀▀▀█████",
    "████████████  ███    █████",
    "█████▀ ▀████  █▀  ▄▄██████",
    "█████    ███    ▄█████████",
    "███████▄  ▀█  ▄███████████",
    "█████████▄    ████████████",
    " ▀▀▀▀▀▀▀▀▀▀   ▀▀▀▀▀▀▀▀▀▀▀",
];
const LOGO_WIDTH: u16 = 26;

/// A key under the card, and the message for what it does.
type Hint = (&'static str, &'static str);
const CHOOSE: Hint = ("\u{2191}\u{2193}", "live.ui.keys.choose");
const INSTALL: Hint = ("Enter", "live.ui.keys.install");
const RESTART: Hint = ("R", "live.ui.keys.restart");
const POWER_OFF: Hint = ("P", "live.ui.keys.power_off");
const SHELL: Hint = ("Alt+F2", "live.ui.keys.shell");
const LANGUAGE: Hint = ("L", "live.ui.keys.language");
const CONTINUE: Hint = ("Enter", "live.ui.keys.continue");
const APPLY: Hint = ("Enter", "live.ui.keys.apply");
const BACK: Hint = ("Esc", "live.ui.keys.back");

/// One disk in the list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiskRow {
    /// Name, type, model and size on one line.
    pub label: String,
    /// Why it can't be used, if it can't.
    pub problem: Option<Problem>,
}

/// Roughly how long a step still takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimeLeft {
    LessThanAMinute,
    /// Rounded up.
    Minutes(u64),
}

/// What the console shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Screen {
    /// The disks to choose from.
    Disks {
        /// What the stick installs ("Home Assistant OS 18.3"), if it has an image.
        os: Option<String>,
        disks: Vec<DiskRow>,
        selected: usize,
        /// Hidden devices, and why.
        hidden: Vec<(String, Hidden)>,
        /// Why the disks couldn't be listed, when they couldn't.
        scan_error: Option<String>,
    },
    /// The typed confirmation before anything is erased.
    Confirm {
        disk: String,
        /// What gets installed ("Home Assistant OS 18.3").
        os: String,
        typed: String,
        /// Something other than `erase` was typed.
        mistyped: bool,
    },
    /// A long step, with how far along it is.
    Progress {
        title: String,
        detail: String,
        percent: u16,
        /// Roughly how long the step still takes, once that can be told.
        time_left: Option<TimeLeft>,
    },
    /// Something went wrong; Enter goes back.
    Message {
        title: String,
        /// One paragraph each.
        body: Vec<String>,
    },
    /// Home Assistant OS is on the disk.
    Done { disk: String },
    /// The languages to switch to.
    Languages { selected: Language },
}

/// Draws `screen` in `lang`: a centered card with the keys to press under it, and the Home
/// Assistant logo above it where the console is tall enough.
pub fn render(frame: &mut Frame, screen: &Screen, lang: Language) {
    let Card {
        title,
        lines,
        progress: gauge,
        keys,
        focus,
    } = content(screen, lang);

    let width = CARD_WIDTH.min(frame.area().width.saturating_sub(2));
    // Borders and padding take 5 columns on each side, padding 2 rows above and below
    let inner_width = width.saturating_sub(10).max(1);
    // A blank line, the bar, and the time left with the percentage under it
    let gauge_height = if gauge.is_some() { 3 } else { 0 };
    let height = (wrapped_height(&lines, inner_width) + gauge_height + 6)
        .min(frame.area().height.saturating_sub(2));

    // The logo, and a blank line under it, only where it doesn't push the card off the screen
    let logo_height = if frame.area().height >= height + 2 + LOGO.len() as u16 + 3 {
        LOGO.len() as u16 + 1
    } else {
        0
    };
    let [logo_area, card, keys_area] = Layout::vertical([
        Constraint::Length(logo_height),
        Constraint::Length(height),
        Constraint::Length(2),
    ])
    .flex(Flex::Center)
    .areas(frame.area());
    if logo_height > 0 {
        let [logo_area] = Layout::horizontal([Constraint::Length(LOGO_WIDTH)])
            .flex(Flex::Center)
            .areas(logo_area);
        frame.render_widget(
            Paragraph::new(LOGO.map(Line::from).to_vec()).fg(ACCENT),
            logo_area,
        );
    }
    let [card] = Layout::horizontal([Constraint::Length(width)])
        .flex(Flex::Center)
        .areas(card);
    let [keys_area] = Layout::horizontal([Constraint::Length(width)])
        .flex(Flex::Center)
        .areas(keys_area);

    let block = Block::bordered()
        .border_style(Style::new().fg(ACCENT))
        .title(Line::from(format!(" {title} ")).fg(ACCENT).bold())
        .padding(Padding::new(4, 4, 2, 2));
    let inner = block.inner(card);
    frame.render_widget(block, card);

    let [text_area, gauge_area] =
        Layout::vertical([Constraint::Fill(1), Constraint::Length(gauge_height)]).areas(inner);
    // Keep the selected disk in view where the list doesn't fit the card
    let scroll = focus.map_or(0, |focus| {
        let through_focus = wrapped_height(&lines[..focus.end], text_area.width);
        through_focus.saturating_sub(text_area.height)
    });
    frame.render_widget(
        Paragraph::new(lines)
            .wrap(Wrap { trim: false })
            .scroll((scroll, 0)),
        text_area,
    );
    if let Some((percent, time_left)) = gauge {
        let [_, bar, below] = Layout::vertical([Constraint::Length(1); 3]).areas(gauge_area);
        frame.render_widget(progress_bar(percent, bar.width), bar);
        let percent_text = format!("{}%", percent.min(100));
        let [left, right] = Layout::horizontal([
            Constraint::Fill(1),
            Constraint::Length(percent_text.len() as u16),
        ])
        .areas(below);
        frame.render_widget(Paragraph::new(time_left.unwrap_or_default()), left);
        frame.render_widget(Paragraph::new(percent_text).fg(ACCENT).bold(), right);
    }

    frame.render_widget(
        Paragraph::new(keys).fg(MUTED).wrap(Wrap { trim: true }),
        // In line with the card's border on both sides
        keys_area.inner(ratatui::layout::Margin::new(1, 0)),
    );
}

/// A bar of `width` columns, `percent` filled. Drawn with characters, because the Linux console
/// can't show a gray background for the part still to go.
fn progress_bar(percent: u16, width: u16) -> Line<'static> {
    let done = (u32::from(width) * u32::from(percent.min(100)) / 100) as usize;
    let left = usize::from(width) - done;
    Line::from(vec![
        Span::from("\u{2588}".repeat(done)).fg(ACCENT),
        Span::from("\u{2591}".repeat(left)).fg(MUTED),
    ])
}

/// What goes in the card for one screen.
struct Card {
    title: String,
    lines: Vec<Line<'static>>,
    /// The percentage, and the time left once that can be told.
    progress: Option<(u16, Option<String>)>,
    /// The keys to press, under the card.
    keys: String,
    /// The lines that must stay in view: the selected disk, and why it can't be used.
    focus: Option<std::ops::Range<usize>>,
}

/// The card of `screen`, in `lang`.
fn content(screen: &Screen, lang: Language) -> Card {
    match screen {
        Screen::Disks {
            os,
            disks,
            selected,
            hidden,
            scan_error,
        } => {
            let title = lang.text("live.ui.disks.title");
            let Some(os) = os else {
                return Card {
                    title,
                    lines: vec![Line::from(lang.text("live.ui.disks.no_image"))],
                    progress: None,
                    keys: key_bar(lang, &[RESTART, POWER_OFF, LANGUAGE]),
                    focus: None,
                };
            };
            let mut lines = vec![
                Line::from(lang.format("live.ui.disks.subtitle", &[("os", os)])),
                Line::default(),
            ];
            if let Some(error) = scan_error {
                lines.push(
                    Line::from(lang.format("live.ui.disks.scan_failed", &[("error", error)]))
                        .fg(WARNING)
                        .bold(),
                );
            } else if disks.is_empty() {
                lines.push(Line::from(lang.text("live.ui.disks.none_found")));
            }
            let mut focus = None;
            for (index, disk) in disks.iter().enumerate() {
                let chosen = index == *selected;
                let first = lines.len();
                let line = choice(&disk.label, chosen);
                match disk.problem {
                    None => lines.push(line),
                    Some(problem) => {
                        lines.push(line.fg(MUTED));
                        let problem = lang.text(problem.key());
                        let text = lang.format("live.ui.disks.problem", &[("problem", &problem)]);
                        lines.push(Line::from(format!("  {text}")).fg(WARNING).bold());
                    }
                }
                if chosen {
                    focus = Some(first..lines.len());
                }
            }
            if !hidden.is_empty() {
                lines.push(Line::default());
                lines.push(Line::from(lang.text("live.ui.disks.hidden_title")).fg(MUTED));
                for line in hidden_summary(lang, hidden) {
                    lines.push(Line::from(format!("  {line}")).fg(MUTED));
                }
            }
            let keys = if disks.is_empty() {
                key_bar(lang, &[RESTART, POWER_OFF, SHELL, LANGUAGE])
            } else {
                key_bar(
                    lang,
                    &[CHOOSE, INSTALL, RESTART, POWER_OFF, SHELL, LANGUAGE],
                )
            };
            Card {
                title,
                lines,
                progress: None,
                keys,
                focus,
            }
        }
        Screen::Confirm {
            disk,
            os,
            typed,
            mistyped,
        } => {
            let erase: &Args = &[("word", &"erase")];
            let mut prompt = spans(lang, "live.ui.confirm.prompt", erase, Style::new().bold());
            prompt.push(Span::from(" "));
            prompt.push(Span::from(format!("{typed}_")).fg(ACCENT).bold());
            let mut lines = vec![
                Line::from(Span::from(disk.clone()).bold()),
                Line::default(),
                Line::from(lang.text("live.ui.confirm.warning"))
                    .fg(WARNING)
                    .bold(),
                Line::from(lang.format("live.ui.confirm.os", &[("os", os)])),
                Line::default(),
                Line::from(prompt),
            ];
            if *mistyped {
                lines.push(
                    Line::from(lang.format("live.ui.confirm.mistyped", erase))
                        .fg(WARNING)
                        .bold(),
                );
            }
            Card {
                title: lang.text("live.ui.confirm.title"),
                lines,
                progress: None,
                keys: key_bar(lang, &[CONTINUE, BACK]),
                focus: None,
            }
        }
        Screen::Progress {
            title,
            detail,
            percent,
            time_left,
        } => {
            let lines = vec![
                Line::from(detail.clone()),
                Line::from(lang.text("live.ui.progress.keep_connected")).fg(MUTED),
            ];
            Card {
                title: title.clone(),
                lines,
                progress: Some((*percent, time_left.map(|left| time_left_text(lang, left)))),
                keys: String::new(),
                focus: None,
            }
        }
        Screen::Message { title, body } => Card {
            title: title.clone(),
            lines: body
                .iter()
                .flat_map(|paragraph| paragraph.lines())
                .map(|line| Line::from(line.to_string()))
                .collect(),
            progress: None,
            keys: key_bar(lang, &[("Enter", "live.ui.keys.back")]),
            focus: None,
        },
        Screen::Done { disk } => Card {
            title: lang.text("live.ui.done.title"),
            lines: vec![
                Line::from(lang.format("live.ui.done.installed", &[("disk", disk)])),
                Line::default(),
                Line::from(lang.text("live.ui.done.remove_stick")),
                Line::from(spans(
                    lang,
                    "live.ui.done.open_home_assistant",
                    &[("url", &HOME_ASSISTANT_URL)],
                    // Can't be selected on the console, so it stands out as the thing to type
                    Style::new().fg(ACCENT).bold(),
                )),
            ],
            progress: None,
            keys: key_bar(lang, &[RESTART, POWER_OFF, LANGUAGE]),
            focus: None,
        },
        Screen::Languages { selected } => {
            let languages = Language::all();
            let index = languages.iter().position(|language| language == selected);
            Card {
                title: and_language(lang, lang.text("live.ui.languages.title")),
                lines: languages
                    .iter()
                    .map(|language| choice(&language.name(), language == selected))
                    .collect(),
                progress: None,
                keys: key_bar(lang, &[CHOOSE, APPLY, BACK]),
                focus: index.map(|index| index..index + 1),
            }
        }
    }
}

/// A line of a list, marked and in the accent color where it's the one chosen.
fn choice(text: &str, chosen: bool) -> Line<'static> {
    if chosen {
        Line::from(format!("\u{25ba} {text}")).fg(ACCENT).bold()
    } else {
        Line::from(format!("  {text}"))
    }
}

/// The message `key` as spans, with every placeholder's value in `style`.
fn spans(lang: Language, key: &str, args: &Args, style: Style) -> Vec<Span<'static>> {
    lang.segments(key, args)
        .into_iter()
        .map(|segment| match segment.placeholder {
            Some(_) => Span::styled(segment.text, style),
            None => Span::from(segment.text),
        })
        .collect()
}

/// The keys under the card. A key stays on the same row as what it does where the bar wraps.
fn key_bar(lang: Language, hints: &[Hint]) -> String {
    hints
        .iter()
        .map(|&hint| {
            let (key, action) = hint;
            let mut action = lang.text(action);
            if hint == LANGUAGE {
                action = and_language(lang, action);
            }
            format!("{key} {action}").replace(' ', "\u{a0}")
        })
        .collect::<Vec<_>>()
        .join("   ")
}

/// `text`, followed by "/Language" outside English, so that someone who can't read the
/// language still finds the way to another one.
fn and_language(lang: Language, text: String) -> String {
    if lang.is_english() {
        return text;
    }
    let language = Language::english().text("live.ui.languages.title");
    format!("{text}/{language}")
}

/// Roughly how long a step that has done `done` of `total` in `elapsed` still takes. `None` until
/// there's enough to go on.
pub fn time_left(elapsed: Duration, done: u64, total: u64) -> Option<TimeLeft> {
    let elapsed = elapsed.as_secs_f64();
    if total == 0 || done == 0 || elapsed < 1.0 {
        return None;
    }

    let seconds = (total.saturating_sub(done)) as f64 / (done as f64 / elapsed);
    if seconds < 60.0 {
        return Some(TimeLeft::LessThanAMinute);
    }
    // Rounded up once, before it's split into hours: 59m 50s left is "1h 0m", never "60 minutes"
    Some(TimeLeft::Minutes((seconds / 60.0).ceil() as u64))
}

/// `time_left` worded like the desktop installer.
fn time_left_text(lang: Language, time_left: TimeLeft) -> String {
    match time_left {
        TimeLeft::LessThanAMinute => lang.text("live.ui.progress.less_than_a_minute_remaining"),
        TimeLeft::Minutes(minutes @ ..60) => lang.format(
            "live.ui.progress.minutes_remaining",
            &[("minutes", &minutes)],
        ),
        TimeLeft::Minutes(minutes) => lang.format(
            "live.ui.progress.hours_remaining",
            &[("hours", &(minutes / 60)), ("minutes", &(minutes % 60))],
        ),
    }
}

/// Rows `lines` takes when word-wrapped to `width` columns, exactly as the card draws them.
fn wrapped_height(lines: &[Line], width: u16) -> u16 {
    Paragraph::new(lines.to_vec())
        .wrap(Wrap { trim: false })
        .line_count(width.max(1)) as u16
}

/// One line per reason a device is hidden. Long lists are counted, not named.
fn hidden_summary(lang: Language, hidden: &[(String, Hidden)]) -> Vec<String> {
    let mut reasons: Vec<Hidden> = hidden.iter().map(|(_, reason)| *reason).collect();
    reasons.sort_unstable();
    reasons.dedup();
    reasons
        .into_iter()
        .map(|reason| {
            let names: Vec<&str> = hidden
                .iter()
                .filter(|(_, r)| *r == reason)
                .map(|(name, _)| name.as_str())
                .collect();
            let reason = lang.text(reason.key());
            if names.len() > 4 {
                let count = names.len();
                lang.format(
                    "live.ui.disks.hidden_count",
                    &[("reason", &reason), ("count", &count)],
                )
            } else {
                let devices = names.join(" ");
                lang.format(
                    "live.ui.disks.hidden_devices",
                    &[("reason", &reason), ("devices", &devices)],
                )
            }
        })
        .collect()
}

/// The console, in raw mode for as long as this lives.
pub struct Ui {
    terminal: Terminal<CrosstermBackend<Stdout>>,
    linux_console: bool,
    /// What every screen is drawn in.
    pub language: Language,
}

impl Ui {
    /// Takes over the console, to draw in `language`.
    pub fn start(language: Language) -> io::Result<Self> {
        let linux_console = std::env::var("TERM").is_ok_and(|term| term == "linux");
        terminal::enable_raw_mode()?;
        let mut stdout = io::stdout();
        if linux_console {
            // The console's own escape for setting a palette entry: blue and bright blue become #18BCF2
            write!(stdout, "\x1b]P418BCF2\x1b]PC18BCF2")?;
        }
        execute!(
            stdout,
            terminal::Clear(terminal::ClearType::All),
            cursor::Hide
        )?;
        Ok(Self {
            terminal: Terminal::new(CrosstermBackend::new(stdout))?,
            linux_console,
            language,
        })
    }

    /// Draws `screen`.
    pub fn show(&mut self, screen: &Screen) {
        let language = self.language;
        let _ = self.terminal.draw(|frame| render(frame, screen, language));
    }

    /// The next key pressed, or `None` once `timeout` passes without one.
    pub fn key(&mut self, timeout: Option<Duration>) -> Option<KeyCode> {
        loop {
            if let Some(timeout) = timeout {
                match event::poll(timeout) {
                    Ok(true) => {}
                    Ok(false) => return None,
                    Err(_) => no_console(),
                }
            }
            match event::read() {
                Ok(Event::Key(key)) if key.kind == KeyEventKind::Press => return Some(key.code),
                // A resized console, for example, just gets drawn again by the caller
                Ok(_) if timeout.is_some() => return None,
                Ok(_) => {}
                Err(_) => no_console(),
            }
        }
    }
}

impl Drop for Ui {
    fn drop(&mut self) {
        let mut stdout = io::stdout();
        if self.linux_console {
            // Back to the console's default palette
            let _ = write!(stdout, "\x1b]R");
        }
        let _ = execute!(stdout, cursor::Show);
        let _ = terminal::disable_raw_mode();
    }
}

/// No console to read from. Exit rather than spin; init restarts hai-live on tty1.
fn no_console() -> ! {
    std::process::exit(1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::drives::Reason;
    use ratatui::backend::TestBackend;
    use ratatui::buffer::Buffer;
    use ratatui::style::Modifier;

    /// The text of `screen` drawn in English on a `width` x `height` console, one string per row.
    fn draw(screen: &Screen, width: u16, height: u16) -> Vec<String> {
        draw_in(Language::english(), screen, width, height)
    }

    fn draw_in(lang: Language, screen: &Screen, width: u16, height: u16) -> Vec<String> {
        let buffer = buffer(lang, screen, width, height);
        (0..height)
            .map(|y| (0..width).map(|x| buffer[(x, y)].symbol()).collect())
            // The key bar's non-breaking spaces read as spaces
            .map(|row: String| row.replace('\u{a0}', " "))
            .collect()
    }

    fn buffer(lang: Language, screen: &Screen, width: u16, height: u16) -> Buffer {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal.draw(|frame| render(frame, screen, lang)).unwrap();
        terminal.backend().buffer().clone()
    }

    fn shows(rows: &[String], text: &str) -> bool {
        rows.iter().any(|row| row.contains(text))
    }

    fn row_of(rows: &[String], text: &str) -> Option<usize> {
        rows.iter().position(|row| row.contains(text))
    }

    fn disks() -> Screen {
        let mut hidden: Vec<(String, Hidden)> = (0..16)
            .map(|n| (format!("ram{n}"), Hidden::Skipped(Reason::RamDisk)))
            .collect();
        hidden.push(("sr0".into(), Hidden::Skipped(Reason::OpticalDrive)));
        Screen::Disks {
            os: Some("Home Assistant OS 18.3".into()),
            disks: vec![
                DiskRow {
                    label: "vda      VirtIO VirtIO disk          34.4 GB".into(),
                    problem: None,
                },
                DiskRow {
                    label: "sda      SATA   Tiny SSD             16.0 GB".into(),
                    problem: Some(Problem::TooSmall),
                },
            ],
            selected: 0,
            hidden,
            scan_error: None,
        }
    }

    #[test]
    fn disk_list_marks_the_choice_and_says_why_others_cant_be_used() {
        let rows = draw(&disks(), 80, 25);
        assert!(shows(&rows, "Home Assistant Installer"));
        assert!(shows(&rows, "\u{25ba} vda"));
        assert!(shows(&rows, "Can't be used: smaller than 32 GB"));
        assert!(shows(&rows, "optical drive: sr0"));
        assert!(shows(&rows, "Enter install"));
        assert!(shows(&rows, "L language"));
        assert!(!shows(&rows, "/Language"));
    }

    #[test]
    fn keeps_the_selected_disk_in_view_when_the_list_is_long() {
        let disks: Vec<DiskRow> = (0..16)
            .map(|n| DiskRow {
                label: format!("sd{}      SATA   Disk {n:<24}  64.0 GB", (b'a' + n) as char),
                // Every other one also needs a line for why it can't be used
                problem: (n % 2 == 1).then_some(Problem::TooSmall),
            })
            .collect();
        let screen = |selected| Screen::Disks {
            os: Some("Home Assistant OS 18.3".into()),
            disks: disks.clone(),
            selected,
            hidden: vec![],
            scan_error: None,
        };

        // 80 x 25, the smallest console: the list doesn't fit the card
        let rows = draw(&screen(15), 80, 25);
        assert!(shows(&rows, "\u{25ba} sdp"), "{}", rows.join("\n"));
        assert!(shows(&rows, "Can't be used"));
        let rows = draw(&screen(0), 80, 25);
        assert!(shows(&rows, "\u{25ba} sda"));
        assert!(shows(&rows, "Choose the disk"));
    }

    /// Every screen, with each text `main` passes in as `lang` has it.
    fn every_screen(lang: Language) -> Vec<Screen> {
        let os = Some("Home Assistant OS 18.3".to_string());
        // The longest error text the OS gives for a disk
        let error = "Inappropriate ioctl for device (os error 25)";
        let disk_list = |os: Option<String>, scan_error: Option<&str>| Screen::Disks {
            os,
            disks: vec![],
            selected: 0,
            hidden: vec![],
            scan_error: scan_error.map(String::from),
        };
        let mut screens = vec![
            disks(),
            disk_list(None, None),
            disk_list(os.clone(), None),
            disk_list(os, Some(error)),
            Screen::Confirm {
                disk: "vda      VirtIO VirtIO disk          34.4 GB".into(),
                os: "Home Assistant OS 18.3".into(),
                typed: "eras".into(),
                mistyped: true,
            },
            Screen::Done {
                disk: "nvme0n1".into(),
            },
            Screen::Languages { selected: lang },
        ];

        let writing = lang.format(
            "live.main.writing.detail",
            &[("disk", &"nvme0n1"), ("gigabytes", &"100.0")],
        );
        let steps = [
            (
                "live.main.checking.title",
                lang.text("live.main.checking.detail"),
            ),
            ("live.main.writing.title", writing),
            (
                "live.main.finishing.title",
                lang.text("live.main.finishing.detail"),
            ),
        ];
        let times = [
            None,
            Some(TimeLeft::LessThanAMinute),
            Some(TimeLeft::Minutes(59)),
            Some(TimeLeft::Minutes(119)),
        ];
        for (title, detail) in steps {
            for time_left in times {
                screens.push(Screen::Progress {
                    title: lang.text(title),
                    detail: detail.clone(),
                    percent: 100,
                    time_left,
                });
            }
        }

        let text = |key| lang.text(key);
        let problem = text("live.safety.problem.too_small");
        let unusable: &Args = &[("disk", &"nvme0n1"), ("problem", &problem)];
        let open_failed: &Args = &[("disk", &"nvme0n1"), ("error", &error)];
        let messages = [
            (
                "live.main.unusable.title",
                vec![lang.format("live.main.unusable.body", unusable)],
            ),
            (
                "live.main.image_damaged.title",
                vec![
                    text("live.main.image_damaged.body"),
                    text("live.main.image_damaged.hint"),
                ],
            ),
            (
                "live.main.read_failed.title",
                vec![error.into(), text("live.main.nothing_written")],
            ),
            (
                "live.main.disk_changed.title",
                vec![text("live.main.disk_changed.body")],
            ),
            (
                "live.main.open_failed.title",
                vec![
                    lang.format("live.main.open_failed.body", open_failed),
                    text("live.main.nothing_written"),
                ],
            ),
            (
                "live.main.write_failed.title",
                vec![error.into(), text("live.main.write_failed.body")],
            ),
            ("live.main.finish_failed.title", vec![error.into()]),
            ("live.main.restart_failed.title", vec![error.into()]),
            ("live.main.power_off_failed.title", vec![error.into()]),
        ];
        for (title, body) in messages {
            screens.push(Screen::Message {
                title: text(title),
                body,
            });
        }
        screens
    }

    /// The part of `card` that doesn't fit an 80 x 25 console, if any. Measured on the card
    /// itself, because [`render`] cuts off whatever doesn't fit the screen.
    fn overflow(card: &Card) -> Option<&'static str> {
        // On 80 columns the card is 78 wide, 68 inside its borders and padding
        let (width, inner_width) = (78, 68);
        let gauge_height = if card.progress.is_some() { 3 } else { 0 };
        // A card with a focus scrolls to it instead
        let height = wrapped_height(&card.lines, inner_width) + gauge_height + 6;
        if card.focus.is_none() && height > 23 {
            return Some("text");
        }
        if Line::from(format!(" {} ", card.title)).width() > usize::from(width - 2) {
            return Some("title");
        }
        if let Some((percent, time_left)) = &card.progress {
            let row = format!("{}{percent}%", time_left.as_deref().unwrap_or_default());
            if Line::from(row).width() > usize::from(inner_width) {
                return Some("time left");
            }
        }
        // The key bar has two rows under the card, one column in from each side
        let keys = Paragraph::new(card.keys.as_str()).wrap(Wrap { trim: true });
        if keys.line_count(width - 2) > 2 {
            return Some("key bar");
        }
        None
    }

    #[test]
    fn every_screen_fits_the_smallest_console() {
        for lang in Language::all() {
            for screen in every_screen(lang) {
                // 80 x 25 is the plain VGA text console, the smallest one there is
                if let Some(part) = overflow(&content(&screen, lang)) {
                    let rows = draw_in(lang, &screen, 80, 25);
                    panic!("{lang:?}: the {part} doesn't fit\n{}", rows.join("\n"));
                }
            }
        }
    }

    #[test]
    fn an_overlong_card_does_not_fit() {
        let overflow_of = |title: &str, body: String| {
            let screen = Screen::Message {
                title: title.into(),
                body: vec![body],
            };
            overflow(&content(&screen, Language::english()))
        };
        let sentence = "Nothing was written. ";
        assert_eq!(overflow_of("Failed", sentence.repeat(30)), None);
        assert_eq!(overflow_of("Failed", sentence.repeat(60)), Some("text"));
        assert_eq!(
            overflow_of(&"Failed ".repeat(11), String::new()),
            Some("title")
        );
    }

    #[test]
    fn confirm_shows_what_is_typed_and_a_mistake() {
        let rows = draw(
            &Screen::Confirm {
                disk: "vda".into(),
                os: "Home Assistant OS 18.3".into(),
                typed: "era".into(),
                mistyped: true,
            },
            80,
            25,
        );
        assert!(shows(&rows, "Everything on this disk will be erased."));
        assert!(shows(&rows, "to continue: era_"));
        assert!(shows(&rows, "Type erase exactly"));
    }

    #[test]
    fn confirm_and_done_style_the_word_to_type_and_the_address() {
        let bold = |screen: &Screen, text: &str| {
            let card = content(screen, Language::english());
            card.lines.iter().flat_map(|line| &line.spans).any(|span| {
                span.content == text && span.style.add_modifier.contains(Modifier::BOLD)
            })
        };
        let confirm = Screen::Confirm {
            disk: "vda".into(),
            os: "Home Assistant OS 18.3".into(),
            typed: String::new(),
            mistyped: false,
        };
        assert!(bold(&confirm, "erase"));
        assert!(bold(
            &Screen::Done { disk: "vda".into() },
            HOME_ASSISTANT_URL
        ));
    }

    #[test]
    fn progress_shows_the_percentage() {
        let rows = draw(
            &Screen::Progress {
                title: "Writing Home Assistant OS".into(),
                detail: "To vda".into(),
                percent: 51,
                time_left: Some(TimeLeft::Minutes(2)),
            },
            80,
            25,
        );
        assert!(shows(&rows, "51%"));
        assert!(shows(&rows, "About 2 minutes remaining"));
        assert!(shows(&rows, "Keep the USB stick connected."));
    }

    #[test]
    fn without_an_image_only_restart_and_power_off_are_offered() {
        let rows = draw(
            &Screen::Disks {
                os: None,
                disks: vec![],
                selected: 0,
                hidden: vec![],
                scan_error: None,
            },
            80,
            25,
        );
        assert!(shows(&rows, "no Home Assistant OS image"));
        assert!(!shows(&rows, "Enter install"));
        assert!(shows(&rows, "L language"));
    }

    #[test]
    fn a_failed_scan_says_so_instead_of_finding_no_disks() {
        let rows = draw(
            &Screen::Disks {
                os: Some("Home Assistant OS 18.3".into()),
                disks: vec![],
                selected: 0,
                hidden: vec![],
                scan_error: Some("Permission denied (os error 13)".into()),
            },
            80,
            25,
        );
        assert!(shows(&rows, "could not be listed"), "{}", rows.join("\n"));
        assert!(!shows(&rows, "No internal disk found"));
    }

    #[test]
    fn shows_the_logo_only_where_there_is_room() {
        let logo_top = LOGO[0].trim();
        assert!(shows(&draw(&disks(), 160, 50), logo_top));
        assert!(!shows(&draw(&disks(), 80, 25), logo_top));
    }

    #[test]
    fn time_left_is_worded_like_the_desktop_installer() {
        let left = |elapsed, done, total| {
            let left = time_left(Duration::from_secs(elapsed), done, total);
            left.map(|left| time_left_text(Language::english(), left))
        };
        assert_eq!(left(0, 10, 100), None);
        assert_eq!(left(10, 0, 100), None);
        assert_eq!(
            left(10, 50, 100).as_deref(),
            Some("Less than a minute remaining")
        );
        assert_eq!(
            left(60, 50, 100).as_deref(),
            Some("About 1 minute remaining")
        );
        assert_eq!(
            left(60, 25, 100).as_deref(),
            Some("About 3 minutes remaining")
        );
        // 59 minutes 50 seconds left
        assert_eq!(left(10, 10, 3600), Some("About 1h 0m remaining".into()));
    }

    #[test]
    fn done_points_to_home_assistant_without_a_port() {
        let card = content(&Screen::Done { disk: "vda".into() }, Language::english());
        let text: Vec<String> = card.lines.iter().map(ToString::to_string).collect();
        let text = text.join(" ");
        assert!(
            text.contains("open http://homeassistant.local in a browser."),
            "{text}"
        );
        assert!(!text.contains(":8123"));
    }

    #[test]
    fn hidden_devices_are_grouped_and_long_lists_counted() {
        let Screen::Disks { hidden, .. } = disks() else {
            unreachable!()
        };
        assert_eq!(
            hidden_summary(Language::english(), &hidden),
            ["RAM disk: 16 devices", "optical drive: sr0"]
        );
    }

    #[test]
    fn the_language_picker_marks_the_active_language() {
        let german = Language::for_tag("de");
        let rows = draw(&Screen::Languages { selected: german }, 80, 25);
        assert!(shows(&rows, " Language "), "{}", rows.join("\n"));
        assert!(shows(&rows, "\u{25ba} Deutsch"));
        assert!(shows(&rows, "  English"));
        // Sorted by their own names
        assert!(row_of(&rows, "Deutsch") < row_of(&rows, "English"));
        assert!(shows(&rows, "Enter apply"));
    }

    #[test]
    fn outside_english_the_language_is_also_labeled_in_english() {
        let german = Language::for_tag("de");
        let rows = draw_in(german, &disks(), 80, 25);
        assert!(shows(&rows, "/Language"), "{}", rows.join("\n"));
        let rows = draw_in(german, &Screen::Languages { selected: german }, 80, 25);
        assert!(shows(&rows, "/Language "), "{}", rows.join("\n"));
    }
}
