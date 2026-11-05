//! Install program that runs on the live USB stick (Alpine, target PC).
//!
//! Lists internal disks, and after a typed confirmation writes the bundled HAOS image to one.

mod drives;
mod image;
mod safety;
mod ui;
mod writer;

use std::fs::File;
use std::io;
use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

use drives::{Disk, Entry};
use image::BundledImage;
use ratatui::crossterm::event::KeyCode;
use ui::{DiskRow, Screen, Ui};

const SYS_BLOCK: &str = "/sys/block";
const DEV: &str = "/dev";
const MEDIA: &str = "/media";
const DISK_CHANGED: &str =
    "The disk changed, disappeared or could not be checked again. Nothing was written.";
/// How often the disk list looks again, so a disk connected later shows up by itself.
const REFRESH: Duration = Duration::from_secs(2);

fn main() {
    let mut ui = match Ui::start() {
        Ok(ui) => ui,
        // No console to draw on. Exit rather than spin; init restarts hai-live on tty1.
        Err(_) => std::process::exit(1),
    };
    let mut selected: Option<String> = None;
    loop {
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
                    label: describe(&choice.disk),
                    problem: choice.problem,
                })
                .collect(),
            selected: index,
            hidden: ui::hidden_summary(&review.hidden),
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
            KeyCode::Char('r' | 'R') => run(&mut ui, "reboot"),
            KeyCode::Char('p' | 'P') => run(&mut ui, "poweroff"),
            KeyCode::Enter => {
                if let (Some(image), Some(choice)) = (&image, review.choices.get(index)) {
                    match choice.problem {
                        Some(problem) => message(
                            &mut ui,
                            "This disk can't be used",
                            &format!("{} can't be used: {problem}.", choice.disk.name),
                        ),
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

    let mut step = Step::start();
    let verified = image::verify(image, &mut |read, total| {
        show_progress(
            ui,
            &mut step,
            "Checking the image",
            "Making sure the Home Assistant OS image on the USB stick is complete.",
            read,
            total,
        )
    });
    match verified {
        Ok(true) => {}
        Ok(false) => {
            return message(
                ui,
                "The image is damaged",
                "The Home Assistant OS image on the USB stick is damaged. Nothing was written.\n\
                 Prepare the stick again with the Home Assistant Installer.",
            )
        }
        Err(error) => {
            return message(
                ui,
                "Could not read the image",
                &format!("{error}\nNothing was written."),
            )
        }
    }

    let (sys_block, dev) = (Path::new(SYS_BLOCK), Path::new(DEV));
    let boot_disk = boot_disk(image);
    let usable = drives::list(sys_block).is_ok_and(|current| {
        safety::still_usable(disk, current, sys_block, dev, boot_disk.as_deref())
    });
    if !usable {
        return message(ui, "Nothing was written", DISK_CHANGED);
    }
    let path = dev.join(&disk.name);
    let mut target = match writer::open_disk(&path) {
        Ok(file) => file,
        Err(error) => {
            return message(
                ui,
                "Could not open the disk",
                &format!(
                    "Could not open {}: {error}\nNothing was written.",
                    disk.name
                ),
            )
        }
    };
    // Checked again after opening, so the disk can't be swapped between the check and the write.
    let unchanged = drives::list(sys_block)
        .is_ok_and(|current| current.contains(&Entry::Disk(disk.clone())))
        && writer::is_same_device(&target, &path);
    if !unchanged {
        return message(ui, "Nothing was written", DISK_CHANGED);
    }
    // Opened before the disk is wiped, so a stick pulled out by now leaves the disk as it was
    let image_file = match File::open(&image.path) {
        Ok(file) => file,
        Err(error) => {
            return message(
                ui,
                "Could not read the image",
                &format!("{error}\nNothing was written."),
            )
        }
    };

    let mut step = Step::start();
    let result = writer::write_image(
        image_file,
        &mut target,
        disk.size_bytes,
        &mut |read, total, written| {
            let detail = format!("To {}: {:.1} GB written.", disk.name, written as f64 / 1e9);
            show_progress(
                ui,
                &mut step,
                "Writing Home Assistant OS",
                &detail,
                read,
                total,
            )
        },
    );
    if let Err(error) = result {
        return message(
            ui,
            "Writing failed",
            &format!("{error}\nThe disk is now incomplete. Install again to fix it."),
        );
    }

    ui.show(&Screen::Progress {
        title: "Finishing".into(),
        detail: "Making sure everything is on the disk.".into(),
        percent: 100,
        time_left: None,
    });
    if let Err(error) = target.sync_all() {
        return message(ui, "Finishing failed", &error.to_string());
    }
    drop(target);

    loop {
        ui.show(&Screen::Done {
            disk: disk.name.clone(),
        });
        match ui.key(None) {
            Some(KeyCode::Char('r' | 'R')) => run(ui, "reboot"),
            Some(KeyCode::Char('p' | 'P')) => run(ui, "poweroff"),
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
            disk: describe(disk),
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

fn describe(disk: &Disk) -> String {
    format!(
        "{:<8} {:<6} {:<30} {:>8.1} GB",
        disk.name,
        disk.kind.label(),
        disk.model,
        disk.size_bytes as f64 / 1e9,
    )
}

/// A long step: when it started, and what was last drawn for it.
struct Step {
    started: Instant,
    shown: Option<(u64, Option<String>)>,
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
    let now = Some((percent, time_left.clone()));
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

/// Shows `body` until Enter or Esc.
fn message(ui: &mut Ui, title: &str, body: &str) {
    loop {
        ui.show(&Screen::Message {
            title: title.into(),
            body: body.into(),
        });
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

fn run(ui: &mut Ui, command: &str) {
    match Command::new(command).status() {
        Ok(status) if status.success() => {}
        Ok(status) => message(ui, &format!("{command} failed"), &status.to_string()),
        Err(error) => message(ui, &format!("{command} failed"), &error.to_string()),
    }
}
