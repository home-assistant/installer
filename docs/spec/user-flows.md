# User Flows

## Installation Paths

### Fully Automated

| Path | Description | How it works |
|------|-------------|--------------|
| Single Board Computers | Pi 3/4/5, ODROID, etc. | Flash SD card |
| Mini PC / NUC | Generic x86-64 or ARM64 | Flash connected SSD/NVMe via USB adapter |
| Home Assistant Hardware | Yellow, Green | Flash or restore device |
| Proxmox | VM on Proxmox VE | API-driven VM creation |
| macOS VM | UTM on macOS | Automated VM setup |

### Docs Redirect

| Path | Reason |
|------|--------|
| Windows VMs | Hyper-V complexity, not a priority |
| Linux VMs | Users can handle it |
| Containers | Different product (HA Container, not HAOS) |
| Unraid | Limited API, good community docs exist |
| Synology | Poor API, good community docs exist |
| Portainer | Container-based, not HAOS |

Back always goes one screen back: on a flow's first step it returns to the
path selection, the same as Back on any other screen. Cancel, Done and
leaving a running VM install also return to the path selection.

---

## Flow: Single Board Computer

### Step 1: Select Device

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│   Select your board                                         │
│                                                             │
│   ┌─────────────────┐  ┌─────────────────┐                  │
│   │  Raspberry Pi 5 │  │  Raspberry Pi 4 │                  │
│   └─────────────────┘  └─────────────────┘                  │
│   ┌─────────────────┐  ┌─────────────────┐                  │
│   │  Raspberry Pi 3 │  │  ODROID-N2+     │                  │
│   └─────────────────┘  └─────────────────┘                  │
│   ┌─────────────────┐  ┌─────────────────┐                  │
│   │  ODROID-M1S     │  │  Other...       │                  │
│   └─────────────────┘  └─────────────────┘                  │
│                                                             │
│                                             [ Back ]        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Step 2: Select Target Drive

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│   Select the SD card to flash                               │
│                                                             │
│   ┌─────────────────────────────────────────────────────┐   │
│   │  ○  Samsung SD Card - 32 GB (/dev/disk4)            │   │
│   └─────────────────────────────────────────────────────┘   │
│   ┌─────────────────────────────────────────────────────┐   │
│   │  ○  SanDisk Ultra - 64 GB (/dev/disk5)              │   │
│   └─────────────────────────────────────────────────────┘   │
│                                                             │
│   ⚠️  All data on the selected drive will be erased         │
│                                                             │
│   [ Refresh ]                          [ Back ] [ Next ]    │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Step 2b: Wi-Fi (boards with built-in Wi-Fi only)

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│   Set up Wi-Fi                                              │
│   Optional. The device joins this network on first start.   │
│                                                             │
│   ( ) Connect to Wi-Fi                                      │
│       Network name  [            ]                          │
│       Password      [            ]  8 to 63 characters      │
│                                                             │
│   Open, WPA3-only and hidden networks aren't supported.     │
│                                                             │
│                                      [ Back ] [ Next ]      │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Step 3: Confirm and Flash

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│   Ready to install                                          │
│                                                             │
│   Device:     Raspberry Pi 5                                │
│   Target:     Samsung SD Card - 32 GB                       │
│   Image:      Home Assistant OS 14.0                        │
│                                                             │
│   Wi-Fi:      Home         (if set up in step 2b)           │
│                                                             │
│   ⚠️  This will erase all data on the SD card               │
│                                                             │
│                                      [ Back ] [ Install ]   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Step 4: Progress

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│   Installing Home Assistant                                 │
│                                                             │
│   ████████████████████░░░░░░░░░░░░░░░░░░░░  45%             │
│                                                             │
│   Downloading image...                                      │
│                                                             │
│   Downloaded: 234 MB / 512 MB                               │
│   Speed: 12.4 MB/s                                          │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Step 5: Complete

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│   ✓  Installation complete                                  │
│                                                             │
│   Your SD card is ready. Next steps:                        │
│                                                             │
│   1. Insert the SD card into your Raspberry Pi 5            │
│   2. Connect ethernet (recommended) or prepare WiFi         │
│   3. Power on the device                                    │
│   4. Wait ~20 minutes for first boot                        │
│   5. Visit http://homeassistant.local                       │
│                                                             │
│                              [ Flash Another ] [ Done ]     │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Flow: Mini PC / NUC

### Step 1: Clarify Setup

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│   How will you install?                                     │
│                                                             │
│   ┌─────────────────────────────────────────────────────┐   │
│   │  I can connect the target drive to this computer    │   │
│   │  I'll plug in the SSD/NVMe via USB adapter          │   │
│   └─────────────────────────────────────────────────────┘   │
│                                                             │
│   ┌─────────────────────────────────────────────────────┐   │
│   │  I need to boot from USB to install                 │   │
│   │  The drive is internal and can't be removed         │   │
│   └─────────────────────────────────────────────────────┘   │
│                                                             │
│                                             [ Back ]        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

If "boot from USB" is selected:

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│   USB Boot Installation                                     │
│                                                             │
│   This installer doesn't create bootable USB installers.    │
│                                                             │
│   For mini PCs where you can't remove the drive, follow     │
│   our guide for creating a bootable USB:                    │
│                                                             │
│   [ Open Installation Guide ]                               │
│                                                             │
│                                             [ Back ]        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

If "connect drive" is selected, continue to:

### Step 2: Select Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│   Select your system type                                   │
│                                                             │
│   ┌─────────────────────────────────────────────────────┐   │
│   │  Generic x86-64 (most mini PCs, NUCs, etc.)         │   │
│   └─────────────────────────────────────────────────────┘   │
│                                                             │
│   ┌─────────────────────────────────────────────────────┐   │
│   │  Generic ARM64 (some SBCs without specific builds)  │   │
│   └─────────────────────────────────────────────────────┘   │
│                                                             │
│                                             [ Back ]        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

Then continues to drive selection (same as SBC flow).

---

## Flow: Home Assistant Hardware

### Step 1: Select Device

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│   Select your device                                        │
│                                                             │
│   ┌─────────────────────────────────────────────────────┐   │
│   │  Home Assistant Green                               │   │
│   └─────────────────────────────────────────────────────┘   │
│                                                             │
│   ┌─────────────────────────────────────────────────────┐   │
│   │  Home Assistant Yellow                              │   │
│   └─────────────────────────────────────────────────────┘   │
│                                                             │
│   ┌─────────────────────────────────────────────────────┐   │
│   │  Home Assistant Blue                                │   │
│   └─────────────────────────────────────────────────────┘   │
│                                                             │
│                                             [ Back ]        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

Next first opens a dialog saying the device is ready to use: the Green and Blue,
and a Yellow bought with its compute module, come with Home Assistant installed
and only need power and Ethernet. A second paragraph says that reinstalling, to
reset or recover it, erases everything on it. Reinstall (Install for a Yellow,
which may need a compute module of the user's own set up) goes on; Go back stays
on the step.

### Step 2: Select Module (Yellow only)

The Yellow has a Raspberry Pi Compute Module 4 or 5 inside, and each is prepared
differently: the CM4 boots a USB flash drive that installs Home Assistant, the
CM5 is written directly over USB-C with rpiboot. So only the Yellow gets this
step, after the dialog, offering the modules the catalog has (the CM5 needs the
`yellow` board). The step indicator shows it as soon as the Yellow is picked.

Then continues to drive selection and flashing.

---

## Flow: Proxmox

### Step 1: Connect

Before authentication, the installer looks at the server's certificate without
sending an HTTP request. A certificate the operating system trusts is validated
the normal way, and the login continues without a question.

Any other certificate opens a "Trust this Proxmox server?" dialog. Most Proxmox
servers use the certificate Proxmox created during installation, and people
reach them by IP address, a local name, or a VPN address, so this is the common
case. The dialog says so, points out that the browser shows the same warning for
the Proxmox web interface, and shows the SHA-256 fingerprint for anyone who
wants to compare it with System > Certificates. Credentials are only sent after
"Trust and connect". Cancel, Escape, or leaving the view sends none.

The trusted certificate is pinned for the login session: every later request,
including uploads and VM API calls, must present exactly that certificate, and
the TLS handshake signature is still verified. A changed certificate is refused
and sends the user back to reconnect, which starts from the same server and
user. The certificate trusted before isn't asked about again; a different one,
or an untrusted one where the platform trusted the certificate before, gets the
question with a warning that it isn't the certificate the server showed last
time. The answer is remembered per server origin, so a second attempt (an
authenticator code, a mistyped password) or editing the address to another
server and back doesn't ask again. Nothing is saved to disk.

Server URLs must be bare HTTPS origins without embedded credentials, paths,
queries, or fragments. API redirects are not followed. Proxmox connections are
direct and do not use system proxies, so a proxy's certificate cannot be
mistaken for the Proxmox certificate.

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│   Connect to your Proxmox server                            │
│                                                             │
│   Server URL   [ https://192.168.1.100:8006 ]               │
│                                                             │
│   Username     [ root@pam                   ]               │
│   Password     [ ••••••••••••••             ]               │
│                                                             │
│                                    [ Back ] [ Connect ]     │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Step 2: Configure VM

Continuing requires an active, non-ESXi storage with free space that accepts
Import on the selected node, in addition to storage for the VM disk. Import
storage can be separate from the selected VM disk storage. Existing usable
Import storage needs no configuration change or approval.

If none is available, show "Import storage required" and keep continuation
disabled. Offer active directory storage with free space as candidates for
"Enable Import...". The confirmation names the chosen storage and explains
that existing content types are preserved, the change applies cluster-wide,
and the installer will not automatically restore the previous setting after
installation. Only choosing "Enable Import" applies the change. "Not now" or
dismissing the dialog makes no change and shows that installation is paused.
The user can reopen the dialog, choose another node, or configure storage in
Proxmox and use "Refresh storage".

After enabling Import, refresh storage and allow continuation only when the
readiness check succeeds. If enabling fails, show the error and advise checking
permissions/configuration; an expired session or changed certificate offers
Reconnect, like the other lookups on this step. If no
directory storage is eligible, advise freeing space, choosing another node, or
updating storage in Proxmox. Whenever Import storage is required, provide a link
to the Proxmox directory storage documentation.

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│   Configure the Home Assistant VM                           │
│                                                             │
│   Node          [ pve             ▼ ]                       │
│   Storage       [ local-lvm       ▼ ]                       │
│   VM ID         [ 100               ]  (auto-suggested)     │
│                                                             │
│   Resources                                                 │
│   CPU cores     [ 2                 ]                       │
│   Memory        [ 2048         ] MB                         │
│   Disk size     [ 32           ] GB                         │
│                                                             │
│   ☑ Start VM after creation                                 │
│                                                             │
│                                 [ Back ] [ Create VM ]      │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Step 3: Progress

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│   Creating Home Assistant VM                                │
│                                                             │
│   ✓  Connected to Proxmox                                   │
│   ✓  Downloaded HAOS image                                  │
│   ⟳  Uploading image to storage...                          │
│   ○  Creating VM                                            │
│   ○  Starting VM                                            │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Step 4: Complete

If this flow successfully enabled Import, show a reminder naming the changed
storages for the current Proxmox server. Do not show it merely because Import
was already enabled. The reminder describes the change made by this installer,
not a fresh verification that nobody has subsequently changed the setting.
Explain that it is cluster-wide and is not restored automatically. Ask the user
to review the storage in Proxmox and remove Import only if no other workflows
need it, keeping other content types unchanged; link to the storage documentation.

Reminder records last for this installation flow, including node changes and
signing back in to the same server. A different server's changes are not shown,
and resetting or starting a new flow clears the records. A later storage refresh
failure does not erase knowledge of an already successful change.

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│   ✓  Home Assistant VM created                              │
│                                                             │
│   VM ID: 100                                                │
│   Status: Running                                           │
│                                                             │
│   Next steps:                                               │
│                                                             │
│   1. Wait ~20 minutes for first boot                        │
│   2. Visit http://homeassistant.local                       │
│      (or check the VM console for the IP address)           │
│                                                             │
│                              [ Create Another ] [ Done ]    │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Flow: macOS VM (UTM)

### Step 1: Check UTM

If UTM is not installed:

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│   UTM Required                                              │
│                                                             │
│   To run Home Assistant in a virtual machine on your Mac,   │
│   you'll need UTM installed.                                │
│                                                             │
│   UTM is a free, open-source virtualizer for macOS.         │
│                                                             │
│   [ Download UTM ]                    [ I've installed it ] │
│                                                             │
│                                             [ Back ]        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

If UTM is installed:

### Step 2: Configure VM

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│   Configure the Home Assistant VM                           │
│                                                             │
│   CPU cores     [ 2                 ]                       │
│   Memory        [ 2048         ] MB                         │
│   Disk size     [ 32           ] GB                         │
│                                                             │
│   ☑ Start VM after creation                                 │
│                                                             │
│                                 [ Back ] [ Create VM ]      │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Step 3: Progress and Complete

Similar to Proxmox flow.

---

## Flow: Other Options

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│   Other Installation Methods                                │
│                                                             │
│   This installer supports direct flashing and automated     │
│   VM setup for Proxmox and UTM. For other platforms,        │
│   we have detailed guides:                                  │
│                                                             │
│   Virtual Machines                                          │
│   ┌─────────────────────────────────────────────────────┐   │
│   │  Windows (Hyper-V, VirtualBox)        [ View Guide ]│   │
│   └─────────────────────────────────────────────────────┘   │
│   ┌─────────────────────────────────────────────────────┐   │
│   │  Linux (KVM, VirtualBox)              [ View Guide ]│   │
│   └─────────────────────────────────────────────────────┘   │
│                                                             │
│   NAS Devices                                               │
│   ┌─────────────────────────────────────────────────────┐   │
│   │  Unraid                               [ View Guide ]│   │
│   └─────────────────────────────────────────────────────┘   │
│   ┌─────────────────────────────────────────────────────┐   │
│   │  Synology                             [ View Guide ]│   │
│   └─────────────────────────────────────────────────────┘   │
│                                                             │
│   Containers                                                │
│   ┌─────────────────────────────────────────────────────┐   │
│   │  Docker / Portainer                   [ View Guide ]│   │
│   │  Note: This runs HA Container, not full HAOS        │   │
│   └─────────────────────────────────────────────────────┘   │
│                                                             │
│                                             [ Back ]        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```
