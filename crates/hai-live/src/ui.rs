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
use ratatui::style::{Color, Modifier, Style, Stylize};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Padding, Paragraph, Wrap};
use ratatui::{Frame, Terminal};

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

/// One disk in the list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiskRow {
    /// Name, type, model and size on one line.
    pub label: String,
    /// Why it can't be used, if it can't.
    pub problem: Option<&'static str>,
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
        /// Hidden devices, one line per reason.
        hidden: Vec<String>,
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
        time_left: Option<String>,
    },
    /// Something went wrong; Enter goes back.
    Message { title: String, body: String },
    /// Home Assistant OS is on the disk.
    Done { disk: String },
}

/// Draws `screen`: a centered card with the keys to press under it, and the Home Assistant logo
/// above it where the console is tall enough.
pub fn render(frame: &mut Frame, screen: &Screen) {
    let Card {
        title,
        lines,
        progress: gauge,
        keys,
        focus,
    } = content(screen);

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
        keys_area.offset(ratatui::layout::Offset { x: 1, y: 0 }),
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

/// The card of `screen`.
fn content(screen: &Screen) -> Card {
    match screen {
        Screen::Disks {
            os,
            disks,
            selected,
            hidden,
            scan_error,
        } => {
            let mut lines = Vec::new();
            let Some(os) = os else {
                lines.push(Line::from(
                    "There is no Home Assistant OS image on this USB stick. \
                     Prepare the stick again with the Home Assistant Installer.",
                ));
                return Card {
                    title: "Home Assistant Installer".into(),
                    lines,
                    progress: None,
                    keys: "R restart   P power off".into(),
                    focus: None,
                };
            };
            lines.push(Line::from(format!(
                "Choose the disk to install {os} on. Everything on it is erased."
            )));
            lines.push(Line::default());
            if let Some(error) = scan_error {
                lines.push(
                    Line::from(format!(
                        "The disks could not be listed: {error}. Trying again by itself."
                    ))
                    .fg(WARNING)
                    .bold(),
                );
            } else if disks.is_empty() {
                lines.push(Line::from(
                    "No internal disk found. Connect one; this list updates by itself.",
                ));
            }
            let mut focus = None;
            for (index, disk) in disks.iter().enumerate() {
                let chosen = index == *selected;
                let first = lines.len();
                let marker = if chosen { "\u{25ba} " } else { "  " };
                let mut style = Style::new();
                if chosen {
                    style = style.fg(ACCENT).add_modifier(Modifier::BOLD);
                }
                if disk.problem.is_some() {
                    style = style.fg(MUTED);
                }
                lines.push(Line::from(format!("{marker}{}", disk.label)).style(style));
                if let Some(problem) = disk.problem {
                    lines.push(
                        Line::from(format!("  Can't be used: {problem}"))
                            .fg(WARNING)
                            .bold(),
                    );
                }
                if chosen {
                    focus = Some(first..lines.len());
                }
            }
            if !hidden.is_empty() {
                lines.push(Line::default());
                lines.push(Line::from("Not shown:").fg(MUTED));
                for line in hidden {
                    lines.push(Line::from(format!("  {line}")).fg(MUTED));
                }
            }
            let keys = if disks.is_empty() {
                "R restart   P power off   Alt+F2 shell"
            } else {
                "\u{2191}\u{2193} choose   Enter install   R restart   P power off   Alt+F2 shell"
            };
            Card {
                title: "Home Assistant Installer".into(),
                lines,
                progress: None,
                keys: keys.into(),
                focus,
            }
        }
        Screen::Confirm {
            disk,
            os,
            typed,
            mistyped,
        } => {
            let mut lines = vec![
                Line::from(Span::from(disk.clone()).bold()),
                Line::default(),
                Line::from("Everything on this disk will be erased.")
                    .fg(WARNING)
                    .bold(),
                Line::from(format!("{os} will be written to it.")),
                Line::default(),
                Line::from(vec![
                    Span::from("Type "),
                    Span::from("erase").bold(),
                    Span::from(" to continue: "),
                    Span::from(format!("{typed}_")).fg(ACCENT).bold(),
                ]),
            ];
            if *mistyped {
                lines.push(
                    Line::from("Type erase exactly, or press Esc to go back.")
                        .fg(WARNING)
                        .bold(),
                );
            }
            Card {
                title: "Erase this disk?".into(),
                lines,
                progress: None,
                keys: "Enter continue   Esc back".into(),
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
                Line::from("Keep the USB stick connected.").fg(MUTED),
            ];
            Card {
                title: title.clone(),
                lines,
                progress: Some((*percent, time_left.clone())),
                keys: String::new(),
                focus: None,
            }
        }
        Screen::Message { title, body } => Card {
            title: title.clone(),
            lines: body
                .lines()
                .map(|line| Line::from(line.to_string()))
                .collect(),
            progress: None,
            keys: "Enter back".into(),
            focus: None,
        },
        Screen::Done { disk } => Card {
            title: "Home Assistant OS is installed".into(),
            lines: vec![
                Line::from(format!("Home Assistant OS is on {disk}.")),
                Line::default(),
                Line::from("Remove the USB stick, then restart the computer."),
                Line::from(vec![
                    Span::from("Home Assistant starts by itself. After a few minutes, open "),
                    // Can't be selected on the console, so it stands out as the thing to type
                    Span::from(HOME_ASSISTANT_URL).fg(ACCENT).bold(),
                    Span::from(" in a browser."),
                ]),
            ],
            progress: None,
            keys: "R restart   P power off".into(),
            focus: None,
        },
    }
}

/// Roughly how long a step that has done `done` of `total` in `elapsed` still takes, worded like
/// the desktop installer. `None` until there's enough to go on.
pub fn time_left(elapsed: Duration, done: u64, total: u64) -> Option<String> {
    let elapsed = elapsed.as_secs_f64();
    if total == 0 || done == 0 || elapsed < 1.0 {
        return None;
    }

    let seconds = (total.saturating_sub(done)) as f64 / (done as f64 / elapsed);
    if seconds < 60.0 {
        return Some("Less than a minute remaining".into());
    }
    // Rounded up once, before splitting: 59m 50s left is "1h 0m", never "60 minutes"
    let minutes = (seconds / 60.0).ceil() as u64;
    Some(match minutes {
        1 => "About 1 minute remaining".into(),
        2..60 => format!("About {minutes} minutes remaining"),
        _ => format!("About {}h {}m remaining", minutes / 60, minutes % 60),
    })
}

/// Rows `lines` takes when word-wrapped to `width` columns, exactly as the card draws them.
fn wrapped_height(lines: &[Line], width: u16) -> u16 {
    Paragraph::new(lines.to_vec())
        .wrap(Wrap { trim: false })
        .line_count(width.max(1)) as u16
}

/// One line per reason a device is hidden. Long lists are counted, not named.
pub fn hidden_summary(hidden: &[(String, &'static str)]) -> Vec<String> {
    let mut reasons: Vec<&str> = hidden.iter().map(|(_, reason)| *reason).collect();
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
            if names.len() > 4 {
                format!("{reason}: {} devices", names.len())
            } else {
                format!("{reason}: {}", names.join(" "))
            }
        })
        .collect()
}

/// The console, in raw mode for as long as this lives.
pub struct Ui {
    terminal: Terminal<CrosstermBackend<Stdout>>,
    linux_console: bool,
}

impl Ui {
    /// Takes over the console.
    pub fn start() -> io::Result<Self> {
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
        })
    }

    /// Draws `screen`.
    pub fn show(&mut self, screen: &Screen) {
        let _ = self.terminal.draw(|frame| render(frame, screen));
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
    use ratatui::backend::TestBackend;

    /// The text of `screen` drawn on a `width` x `height` console, one string per row.
    fn draw(screen: &Screen, width: u16, height: u16) -> Vec<String> {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal.draw(|frame| render(frame, screen)).unwrap();
        let buffer = terminal.backend().buffer();
        (0..height)
            .map(|y| (0..width).map(|x| buffer[(x, y)].symbol()).collect())
            .collect()
    }

    fn shows(rows: &[String], text: &str) -> bool {
        rows.iter().any(|row| row.contains(text))
    }

    fn disks() -> Screen {
        Screen::Disks {
            os: Some("Home Assistant OS 18.3".into()),
            disks: vec![
                DiskRow {
                    label: "vda      VirtIO VirtIO disk          34.4 GB".into(),
                    problem: None,
                },
                DiskRow {
                    label: "sda      SATA   Tiny SSD             16.0 GB".into(),
                    problem: Some("smaller than 32 GB"),
                },
            ],
            selected: 0,
            hidden: vec!["optical drive: sr0".into(), "RAM disk: 16 devices".into()],
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
    }

    #[test]
    fn keeps_the_selected_disk_in_view_when_the_list_is_long() {
        let disks: Vec<DiskRow> = (0..16)
            .map(|n| DiskRow {
                label: format!("sd{}      SATA   Disk {n:<24}  64.0 GB", (b'a' + n) as char),
                // Every other one also needs a line for why it can't be used
                problem: (n % 2 == 1).then_some("smaller than 32 GB"),
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

    #[test]
    fn every_screen_fits_the_smallest_console() {
        let screens = [
            disks(),
            Screen::Confirm {
                disk: "vda      VirtIO VirtIO disk          34.4 GB".into(),
                os: "Home Assistant OS 18.3".into(),
                typed: "eras".into(),
                mistyped: true,
            },
            Screen::Progress {
                title: "Writing Home Assistant OS".into(),
                detail: "To vda: 0.9 GB written".into(),
                percent: 51,
                time_left: Some("About 2 minutes remaining".into()),
            },
            Screen::Message {
                title: "Nothing was written".into(),
                body: "The disk changed, disappeared or could not be checked again.".into(),
            },
            Screen::Done { disk: "vda".into() },
        ];
        for screen in screens {
            // 80 x 25 is the plain VGA text console, the smallest one there is
            let rows = draw(&screen, 80, 25);
            let corners = rows.iter().filter(|row| row.contains('\u{2518}')).count();
            assert_eq!(corners, 1, "{screen:?}\n{}", rows.join("\n"));
        }
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
    fn progress_shows_the_percentage() {
        let rows = draw(
            &Screen::Progress {
                title: "Writing Home Assistant OS".into(),
                detail: "To vda".into(),
                percent: 51,
                time_left: Some("About 2 minutes remaining".into()),
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
        let left = |elapsed, done, total| time_left(Duration::from_secs(elapsed), done, total);
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
        let card = content(&Screen::Done { disk: "vda".into() });
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
        let mut hidden: Vec<(String, &'static str)> =
            (0..16).map(|n| (format!("ram{n}"), "RAM disk")).collect();
        hidden.push(("sr0".into(), "optical drive"));
        assert_eq!(
            hidden_summary(&hidden),
            ["RAM disk: 16 devices", "optical drive: sr0"]
        );
    }
}
