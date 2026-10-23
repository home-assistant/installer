//! Install program that runs on the live USB stick (Alpine, target PC).
//!
//! Lists internal disks, and after a typed confirmation writes the bundled HAOS image to one.

mod drives;
mod image;
mod safety;
mod writer;

use std::io::{BufRead, Write};
use std::path::Path;
use std::process::Command;

use drives::{Disk, Entry};
use image::BundledImage;

const SYS_BLOCK: &str = "/sys/block";
const DEV: &str = "/dev";
const MEDIA: &str = "/media";
const DISK_CHANGED: &str =
    "The disk changed, disappeared or could not be checked again. Nothing was written.";

fn main() {
    loop {
        header();
        let image = image::find(Path::new(MEDIA));
        match &image {
            Some(image) => println!("Home Assistant OS image: {}", image.name()),
            None => println!("No Home Assistant OS image found on the USB stick."),
        }
        let review = show_disks();

        println!("\nAlt+F2 opens a root shell for debugging.");
        let question = if image.is_some() && !review.choices.is_empty() {
            "Disk number = install, r = reboot, p = power off, Enter = refresh: "
        } else {
            "r = reboot, p = power off, Enter = refresh: "
        };
        let answer = prompt(question);
        match answer.as_str() {
            "r" => run("reboot"),
            "p" => run("poweroff"),
            _ => {
                let chosen = answer
                    .parse::<usize>()
                    .ok()
                    .and_then(|n| review.choices.get(n.wrapping_sub(1)));
                if let (Some(image), Some(choice)) = (&image, chosen) {
                    match choice.problem {
                        Some(problem) => {
                            println!("\n{} can't be used: {problem}.", choice.disk.name);
                            prompt("Press Enter to go back.");
                        }
                        None => install(image, &choice.disk),
                    }
                }
            }
        }
    }
}

fn header() {
    // Clear the screen and move the cursor to the top left.
    print!("\x1b[2J\x1b[H");
    println!("==========================================");
    println!(" HAI live USB: hai-live {}", env!("CARGO_PKG_VERSION"));
    println!("==========================================\n");
}

fn install(image: &BundledImage, disk: &Disk) {
    header();
    println!("You chose:\n");
    println!("  {}", describe(disk));
    println!("\nEVERYTHING ON THIS DISK WILL BE ERASED.");
    println!(
        "Home Assistant OS ({}) will be written to it.\n",
        image.name()
    );
    if prompt("Type erase to continue, or press Enter to go back: ") != "erase" {
        return;
    }

    println!("\nChecking the Home Assistant OS image...");
    let mut last = None;
    match image::verify(image, &mut |read, total| {
        show_percent(&mut last, "Checking", read, total, "")
    }) {
        Ok(true) => println!("\n  Image OK."),
        Ok(false) => {
            return fail("The image on the USB stick is damaged. Prepare the stick again.")
        }
        Err(error) => return fail(&format!("Could not read the image: {error}")),
    }

    let (sys_block, dev) = (Path::new(SYS_BLOCK), Path::new(DEV));
    let usable = drives::list(sys_block)
        .is_ok_and(|current| safety::still_usable(disk, current, sys_block, dev));
    if !usable {
        return fail(DISK_CHANGED);
    }
    let path = dev.join(&disk.name);
    let mut target = match writer::open_disk(&path) {
        Ok(file) => file,
        Err(error) => return fail(&format!("Could not open {}: {error}", disk.name)),
    };
    // Checked again after opening, so the disk can't be swapped between the check and the write.
    let unchanged = drives::list(sys_block)
        .is_ok_and(|current| current.contains(&Entry::Disk(disk.clone())))
        && writer::is_same_device(&target, &path);
    if !unchanged {
        return fail(DISK_CHANGED);
    }
    println!("\nWriting Home Assistant OS to {}...", disk.name);
    let mut last = None;
    let result = writer::write_image(
        &image.path,
        &mut target,
        disk.size_bytes,
        &mut |read, total, written| {
            let note = format!("  ({:.1} GB written)", written as f64 / 1e9);
            show_percent(&mut last, "Writing", read, total, &note)
        },
    );
    if let Err(error) = result {
        return fail(&format!(
            "Writing failed: {error}\nThe disk is now incomplete; run the install again."
        ));
    }

    println!("\n\nFinishing (making sure everything is on the disk)...");
    if let Err(error) = target.sync_all() {
        return fail(&format!("Finishing failed: {error}"));
    }
    drop(target);

    header();
    println!("Home Assistant OS is installed on {}.\n", disk.name);
    println!("Remove the USB stick, then reboot.");
    loop {
        match prompt("\nr = reboot, p = power off: ").as_str() {
            "r" => run("reboot"),
            "p" => run("poweroff"),
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

/// Prints `label: NN%` on one line, only when the whole percentage changes.
fn show_percent(last: &mut Option<u64>, label: &str, done: u64, total: u64, note: &str) {
    let percent = (done * 100).checked_div(total).unwrap_or(0);
    if *last != Some(percent) {
        *last = Some(percent);
        print!("\r  {label}: {percent:>3}%{note}   ");
        let _ = std::io::stdout().flush();
    }
}

fn fail(message: &str) {
    println!("\n\n{message}");
    prompt("Press Enter to go back.");
}

fn show_disks() -> safety::Review {
    let (sys_block, dev) = (Path::new(SYS_BLOCK), Path::new(DEV));
    let entries = match drives::list(sys_block) {
        Ok(entries) => entries,
        Err(error) => {
            println!("\nCould not list disks: {error}");
            return safety::Review::default();
        }
    };
    let review = safety::review(entries, sys_block, dev);

    println!("\nDisks:");
    if review.choices.is_empty() {
        println!("  No internal disks found.");
    }
    for (number, choice) in review.choices.iter().enumerate() {
        let note = choice
            .problem
            .map(|p| format!("  NOT USABLE: {p}"))
            .unwrap_or_default();
        println!("  {}) {}{note}", number + 1, describe(&choice.disk));
    }

    println!("\nHidden:");
    let mut reasons: Vec<&str> = review.hidden.iter().map(|(_, r)| *r).collect();
    reasons.sort_unstable();
    reasons.dedup();
    for reason in reasons {
        let names: Vec<&str> = review
            .hidden
            .iter()
            .filter(|(_, r)| *r == reason)
            .map(|(n, _)| n.as_str())
            .collect();
        println!("  {reason}: {}", names.join(" "));
    }
    review
}

fn prompt(question: &str) -> String {
    print!("{question}");
    let _ = std::io::stdout().flush();
    let mut answer = String::new();
    match std::io::stdin().lock().read_line(&mut answer) {
        // No console to read from. Exit rather than spin; init restarts hai-live on tty1.
        Ok(0) | Err(_) => std::process::exit(1),
        Ok(_) => answer.trim().to_string(),
    }
}

fn run(command: &str) {
    if let Err(error) = Command::new(command).status() {
        println!("{command} failed: {error}");
        prompt("Press Enter to continue.");
    }
}
