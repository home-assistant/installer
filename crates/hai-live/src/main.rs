//! Install program that runs on the live USB stick (Alpine, target PC).
//!
//! Lists internal disks, and after a confirmation writes the bundled HAOS image to one.

mod console_font;
mod drives;
mod i18n;
mod image;
mod safety;
mod ui;
mod writer;

use std::fs::{self, File};
use std::io;
use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

use drives::{Disk, Entry, Model};
use i18n::Language;
use image::BundledImage;
use ratatui::crossterm::event::KeyCode;
use ui::{Action, DiskRow, Screen, Ui};

const SYS_BLOCK: &str = "/sys/block";
const DEV: &str = "/dev";
const MEDIA: &str = "/media";
/// The language to start in: one BCP 47 tag, the desktop installer's when it prepared the stick.
const LANGUAGE: &str = "/etc/hai-live/language";
/// How often the disk list looks again, so a disk connected later shows up by itself.
const REFRESH: Duration = Duration::from_secs(2);

fn main() {
    // Without the file, or for a language without a catalog, English
    let language = Language::for_tag(fs::read_to_string(LANGUAGE).unwrap_or_default().trim());
    let mut ui = match Ui::start(language) {
        Ok(ui) => ui,
        // No console to draw on. Exit rather than spin; init restarts hai-live on tty1.
        Err(_) => std::process::exit(1),
    };
    let mut selected: Option<Selected> = None;
    loop {
        let lang = ui.language;
        let image = image::find(Path::new(MEDIA));
        let (review, scan_error) = match review_disks(image.as_ref()) {
            Ok(review) => (review, None),
            // Shown instead of an empty list; it's tried again on the next refresh
            Err(error) => (safety::Review::default(), Some(error.to_string())),
        };
        // Without an image there's nothing to install, so only the actions are offered
        let disks = match image {
            Some(_) => review.choices.as_slice(),
            None => &[],
        };
        // Keep the same line selected while the list refreshes
        let index = selected
            .as_ref()
            .and_then(|selected| position(disks, selected))
            .unwrap_or(0);
        selected = Some(selection(disks, index));
        ui.show(&Screen::Disks {
            os: image.as_ref().map(BundledImage::name),
            disks: disks
                .iter()
                .map(|choice| DiskRow {
                    label: describe(lang, &choice.disk),
                    problem: choice.problem,
                })
                .collect(),
            selected: index,
            hidden: review.hidden,
            scan_error,
        });

        let Some(key) = ui.key(Some(REFRESH)) else {
            continue;
        };
        match (key, disks.get(index), &image) {
            (KeyCode::Enter, Some(choice), Some(image)) => match choice.problem {
                Some(problem) => {
                    let problem = lang.text(problem.key());
                    let body = lang.format(
                        "live.main.unusable.body",
                        &[("disk", &choice.disk.name), ("problem", &problem)],
                    );
                    message(&mut ui, lang.text("live.main.unusable.title"), vec![body])
                }
                None => install(&mut ui, image, &choice.disk),
            },
            (KeyCode::Enter, ..) => act(&mut ui, Action::ALL[index - disks.len()]),
            _ => match shortcut(key) {
                Some(action) => act(&mut ui, action),
                None => {
                    if let Some(index) = moved(key, index, disks.len() + Action::ALL.len()) {
                        selected = Some(selection(disks, index));
                    }
                }
            },
        }
    }
}

/// What the disk list has selected. A disk goes by name, so it stays selected while the list
/// refreshes.
enum Selected {
    Disk(String),
    Action(Action),
}

/// Where `selected` is in the disk list: its disks, then the actions.
fn position(disks: &[safety::Choice], selected: &Selected) -> Option<usize> {
    match selected {
        Selected::Disk(name) => disks.iter().position(|choice| &choice.disk.name == name),
        Selected::Action(action) => Action::ALL
            .iter()
            .position(|other| other == action)
            .map(|index| disks.len() + index),
    }
}

/// What is at `index` in the disk list.
fn selection(disks: &[safety::Choice], index: usize) -> Selected {
    match disks.get(index) {
        Some(choice) => Selected::Disk(choice.disk.name.clone()),
        None => Selected::Action(Action::ALL[index - disks.len()]),
    }
}

/// `index` moved by ↑ or ↓ in a list of `len`, or `None` where `key` moves nothing.
fn moved(key: KeyCode, index: usize, len: usize) -> Option<usize> {
    match key {
        KeyCode::Up | KeyCode::Char('k') => Some(index.saturating_sub(1)),
        KeyCode::Down | KeyCode::Char('j') => Some((index + 1).min(len - 1)),
        _ => None,
    }
}

/// The action a letter starts directly, for those who know the keys. Each is in the list too:
/// with the console's US keymap, some keyboards (Turkish F) have the letter elsewhere.
fn shortcut(key: KeyCode) -> Option<Action> {
    match key {
        KeyCode::Char('r' | 'R') => Some(Action::Restart),
        KeyCode::Char('p' | 'P') => Some(Action::PowerOff),
        KeyCode::Char('l' | 'L') => Some(Action::ChangeLanguage),
        _ => None,
    }
}

fn act(ui: &mut Ui, action: Action) {
    match action {
        Action::Restart => run(ui, "reboot", "live.main.restart_failed.title"),
        Action::PowerOff => run(ui, "poweroff", "live.main.power_off_failed.title"),
        Action::ChangeLanguage => choose_language(ui),
    }
}

/// Asks for confirmation, then checks the image and writes it to `disk`.
fn install(ui: &mut Ui, image: &BundledImage, disk: &Disk) {
    if !confirm_erase(ui, image, disk) {
        return;
    }
    let lang = ui.language;

    let mut step = Step::start();
    let title = lang.text("live.main.checking.title");
    let detail = lang.text("live.main.checking.detail");
    let verified = image::verify(image, &mut |read, total| {
        show_progress(ui, &mut step, &title, || detail.clone(), read, total)
    });
    match verified {
        Ok(true) => {}
        Ok(false) => {
            return message(
                ui,
                lang.text("live.main.image_damaged.title"),
                vec![
                    lang.text("live.main.image_damaged.body"),
                    lang.text("live.main.image_damaged.hint"),
                ],
            )
        }
        Err(error) => {
            return message(
                ui,
                lang.text("live.main.read_failed.title"),
                vec![error.to_string(), lang.text("live.main.nothing_written")],
            )
        }
    }

    let (sys_block, dev) = (Path::new(SYS_BLOCK), Path::new(DEV));
    let boot_disk = boot_disk(image);
    let usable = drives::list(sys_block).is_ok_and(|current| {
        safety::still_usable(disk, current, sys_block, dev, boot_disk.as_deref())
    });
    if !usable {
        return message(
            ui,
            lang.text("live.main.disk_changed.title"),
            vec![lang.text("live.main.disk_changed.body")],
        );
    }
    let path = dev.join(&disk.name);
    let mut target = match writer::open_disk(&path) {
        Ok(file) => file,
        Err(error) => {
            return message(
                ui,
                lang.text("live.main.open_failed.title"),
                vec![
                    lang.format(
                        "live.main.open_failed.body",
                        &[("disk", &disk.name), ("error", &error)],
                    ),
                    lang.text("live.main.nothing_written"),
                ],
            );
        }
    };
    // Checked again after opening, so the disk can't be swapped between the check and the write.
    let unchanged = drives::list(sys_block)
        .is_ok_and(|current| current.contains(&Entry::Disk(disk.clone())))
        && writer::is_same_device(&target, &path);
    if !unchanged {
        return message(
            ui,
            lang.text("live.main.disk_changed.title"),
            vec![lang.text("live.main.disk_changed.body")],
        );
    }
    // Opened before the disk is wiped, so a stick pulled out by now leaves the disk as it was
    let image_file = match File::open(&image.path) {
        Ok(file) => file,
        Err(error) => {
            return message(
                ui,
                lang.text("live.main.read_failed.title"),
                vec![error.to_string(), lang.text("live.main.nothing_written")],
            )
        }
    };

    let mut step = Step::start();
    let title = lang.text("live.main.writing.title");
    let result = writer::write_image(
        image_file,
        &mut target,
        disk.size_bytes,
        &mut |read, total, written| {
            let detail = || {
                let gigabytes = lang.decimal(written as f64 / 1e9);
                lang.format(
                    "live.main.writing.detail",
                    &[("disk", &disk.name), ("gigabytes", &gigabytes)],
                )
            };
            show_progress(ui, &mut step, &title, detail, read, total)
        },
    );
    if let Err(error) = result {
        return message(
            ui,
            lang.text("live.main.write_failed.title"),
            vec![error.to_string(), lang.text("live.main.write_failed.body")],
        );
    }

    ui.show(&Screen::Progress {
        title: lang.text("live.main.finishing.title"),
        detail: lang.text("live.main.finishing.detail"),
        percent: 100,
        time_left: None,
    });
    if let Err(error) = target.sync_all() {
        return message(
            ui,
            lang.text("live.main.finish_failed.title"),
            vec![error.to_string()],
        );
    }
    drop(target);

    let mut index = 0;
    loop {
        ui.show(&Screen::Done {
            disk: disk.name.clone(),
            selected: index,
        });
        match ui.key(None) {
            Some(KeyCode::Enter) => act(ui, Action::ALL[index]),
            Some(key) => match shortcut(key) {
                Some(action) => act(ui, action),
                None => index = moved(key, index, Action::ALL.len()).unwrap_or(index),
            },
            None => {}
        }
    }
}

/// Lets the user switch every screen to another language. Esc keeps the current one.
fn choose_language(ui: &mut Ui) {
    let languages = Language::all();
    let mut index = languages
        .iter()
        .position(|language| *language == ui.language)
        .unwrap_or(0);
    loop {
        ui.show(&Screen::Languages {
            selected: languages[index],
        });
        match ui.key(None) {
            Some(KeyCode::Enter) => {
                ui.language = languages[index];
                return;
            }
            Some(KeyCode::Esc) => return,
            Some(key) => index = moved(key, index, languages.len()).unwrap_or(index),
            None => {}
        }
    }
}

/// Whether erasing `disk` was chosen. Going back is selected first, so an Enter out of habit
/// erases nothing; Esc goes back too.
fn confirm_erase(ui: &mut Ui, image: &BundledImage, disk: &Disk) -> bool {
    let mut erase = false;
    loop {
        ui.show(&Screen::Confirm {
            disk: describe(ui.language, disk),
            os: image.name(),
            erase,
        });
        match ui.key(None) {
            Some(KeyCode::Enter) => return erase,
            Some(KeyCode::Esc) => return false,
            Some(key) => {
                if let Some(index) = moved(key, usize::from(erase), 2) {
                    erase = index == 1;
                }
            }
            None => {}
        }
    }
}

fn describe(lang: Language, disk: &Disk) -> String {
    let model = match &disk.model {
        Model::Reported(model) => model.clone(),
        Model::Virtio => lang.text("live.drives.model.virtio"),
        Model::Unknown => lang.text("live.drives.model.unknown"),
    };
    format!(
        "{:<8} {:<6} {:<30} {:>8} GB",
        disk.name,
        disk.kind.label(),
        model,
        lang.decimal(disk.size_bytes as f64 / 1e9),
    )
}

/// A long step: when it started, and what was last drawn for it.
struct Step {
    started: Instant,
    shown: Option<(u64, Option<ui::TimeLeft>)>,
}

impl Step {
    fn start() -> Self {
        Self {
            started: Instant::now(),
            shown: None,
        }
    }
}

/// Draws the progress of `step`, only when the whole percentage or the time left changes.
fn show_progress(
    ui: &mut Ui,
    step: &mut Step,
    title: &str,
    detail: impl FnOnce() -> String,
    done: u64,
    total: u64,
) {
    let percent = (done * 100).checked_div(total).unwrap_or(0).min(100);
    let time_left = ui::time_left(step.started.elapsed(), done, total);
    let now = Some((percent, time_left));
    if step.shown != now {
        step.shown = now;
        ui.show(&Screen::Progress {
            title: title.into(),
            detail: detail(),
            percent: percent as u16,
            time_left,
        });
    }
}

/// Shows `body`, one paragraph each, until Enter or Esc.
fn message(ui: &mut Ui, title: String, body: Vec<String>) {
    let screen = Screen::Message { title, body };
    loop {
        ui.show(&screen);
        if matches!(ui.key(None), Some(KeyCode::Enter | KeyCode::Esc)) {
            return;
        }
    }
}

fn review_disks(image: Option<&BundledImage>) -> io::Result<safety::Review> {
    let (sys_block, dev) = (Path::new(SYS_BLOCK), Path::new(DEV));
    let boot_disk = image.and_then(boot_disk);
    Ok(safety::review(
        drives::list(sys_block)?,
        sys_block,
        dev,
        boot_disk.as_deref(),
    ))
}

/// The disk the image is read from, so it's never offered as a target.
fn boot_disk(image: &BundledImage) -> Option<String> {
    drives::disk_holding(Path::new(SYS_BLOCK), &image.path)
}

/// Runs `command`, and shows the message `failed` with why where it fails.
fn run(ui: &mut Ui, command: &str, failed: &str) {
    let why = match Command::new(command).status() {
        Ok(status) if status.success() => return,
        Ok(status) => status.to_string(),
        Err(error) => error.to_string(),
    };
    let title = ui.language.text(failed);
    message(ui, title, vec![why]);
}
