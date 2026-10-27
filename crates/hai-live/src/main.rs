//! Install program that runs on the live USB stick (Alpine, target PC).
//!
//! Lists internal disks, and after a typed confirmation writes the bundled HAOS image to one.

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
use ui::{DiskRow, Screen, Ui};

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
    let mut selected: Option<String> = None;
    loop {
        let lang = ui.language;
        let image = image::find(Path::new(MEDIA));
        let (review, scan_error) = match review_disks(image.as_ref()) {
            Ok(review) => (review, None),
            // Shown instead of an empty list; it's tried again on the next refresh
            Err(error) => (safety::Review::default(), Some(error.to_string())),
        };
        // Keep the same disk selected while the list refreshes
        let index = selected
            .as_ref()
            .and_then(|name| review.choices.iter().position(|c| &c.disk.name == name))
            .unwrap_or(0);
        selected = review.choices.get(index).map(|c| c.disk.name.clone());
        ui.show(&Screen::Disks {
            os: image.as_ref().map(BundledImage::name),
            disks: review
                .choices
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
        let last = review.choices.len().saturating_sub(1);
        match key {
            KeyCode::Up | KeyCode::Char('k') => {
                selected = review.choices.get(index.saturating_sub(1)).map(name_of);
            }
            KeyCode::Down | KeyCode::Char('j') => {
                selected = review.choices.get((index + 1).min(last)).map(name_of);
            }
            KeyCode::Char('r' | 'R') => run(&mut ui, "reboot", "live.main.restart_failed.title"),
            KeyCode::Char('p' | 'P') => {
                run(&mut ui, "poweroff", "live.main.power_off_failed.title")
            }
            KeyCode::Char('l' | 'L') => choose_language(&mut ui),
            KeyCode::Enter => {
                if let (Some(image), Some(choice)) = (&image, review.choices.get(index)) {
                    match choice.problem {
                        Some(problem) => {
                            let problem = lang.text(problem.key());
                            let body = lang.format(
                                "live.main.unusable.body",
                                &[("disk", &choice.disk.name), ("problem", &problem)],
                            );
                            message(&mut ui, lang.text("live.main.unusable.title"), vec![body])
                        }
                        None => install(&mut ui, image, &choice.disk),
                    }
                }
            }
            _ => {}
        }
    }
}

fn name_of(choice: &safety::Choice) -> String {
    choice.disk.name.clone()
}

/// Asks for the typed confirmation, then checks the image and writes it to `disk`.
fn install(ui: &mut Ui, image: &BundledImage, disk: &Disk) {
    if !confirm_erase(ui, image, disk) {
        return;
    }
    let lang = ui.language;

    let mut step = Step::start();
    let title = lang.text("live.main.checking.title");
    let detail = lang.text("live.main.checking.detail");
    let verified = image::verify(image, &mut |read, total| {
        show_progress(ui, &mut step, &title, &detail, read, total)
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
            let gigabytes = format!("{:.1}", written as f64 / 1e9);
            let detail = lang.format(
                "live.main.writing.detail",
                &[("disk", &disk.name), ("gigabytes", &gigabytes)],
            );
            show_progress(ui, &mut step, &title, &detail, read, total)
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

    loop {
        ui.show(&Screen::Done {
            disk: disk.name.clone(),
        });
        match ui.key(None) {
            Some(KeyCode::Char('r' | 'R')) => run(ui, "reboot", "live.main.restart_failed.title"),
            Some(KeyCode::Char('p' | 'P')) => {
                run(ui, "poweroff", "live.main.power_off_failed.title")
            }
            Some(KeyCode::Char('l' | 'L')) => choose_language(ui),
            _ => {}
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
            Some(KeyCode::Up | KeyCode::Char('k')) => index = index.saturating_sub(1),
            Some(KeyCode::Down | KeyCode::Char('j')) => {
                index = (index + 1).min(languages.len() - 1);
            }
            Some(KeyCode::Enter) => {
                ui.language = languages[index];
                return;
            }
            Some(KeyCode::Esc) => return,
            _ => {}
        }
    }
}

/// Whether `erase` was typed for `disk`. Esc, or Enter on an empty line, goes back.
fn confirm_erase(ui: &mut Ui, image: &BundledImage, disk: &Disk) -> bool {
    let mut typed = String::new();
    let mut mistyped = false;
    loop {
        ui.show(&Screen::Confirm {
            disk: describe(ui.language, disk),
            os: image.name(),
            typed: typed.clone(),
            mistyped,
        });
        match ui.key(None) {
            Some(KeyCode::Esc) => return false,
            Some(KeyCode::Enter) if typed.is_empty() => return false,
            Some(KeyCode::Enter) if typed == "erase" => return true,
            Some(KeyCode::Enter) => {
                typed.clear();
                mistyped = true;
            }
            Some(KeyCode::Backspace) => {
                typed.pop();
            }
            Some(KeyCode::Char(c)) if typed.len() < 16 => typed.push(c),
            _ => {}
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
        "{:<8} {:<6} {:<30} {:>8.1} GB",
        disk.name,
        disk.kind.label(),
        model,
        disk.size_bytes as f64 / 1e9,
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
fn show_progress(ui: &mut Ui, step: &mut Step, title: &str, detail: &str, done: u64, total: u64) {
    let percent = (done * 100).checked_div(total).unwrap_or(0).min(100);
    let time_left = ui::time_left(step.started.elapsed(), done, total);
    let now = Some((percent, time_left));
    if step.shown != now {
        step.shown = now;
        ui.show(&Screen::Progress {
            title: title.into(),
            detail: detail.into(),
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
