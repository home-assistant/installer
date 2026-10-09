// Generated from hai-core Rust wire types by ts-rs. Do not edit.
// Regenerate with npm run generate:types.

export type BlockDevice = {
/**
 * Unique identifier (e.g., "/dev/sda" on Linux, "disk2" on macOS)
 */
id: string,
/**
 * Human-readable name
 */
name: string,
/**
 * Size in bytes
 */
size: number,
/**
 * Device type
 */
device_type: DeviceType,
/**
 * Whether this is a removable device
 */
removable: boolean,
/**
 * Model name if available
 */
model: string | null,
/**
 * Vendor name if available
 */
vendor: string | null,
/**
 * Hardware serial, when reported by the device (not a filesystem UUID).
 */
serial: string | null, };

export type DeviceType = "sd_card" | "usb_drive" | "ssd" | "hdd" | "nvme" | "unknown";

export type FlashProgress = {
/**
 * Current stage of the process
 */
stage: FlashStage,
/**
 * Progress percentage (0-100)
 */
progress: number,
/**
 * Bytes processed so far
 */
bytes_processed: number,
/**
 * Total bytes to process
 */
total_bytes: number,
/**
 * Human-readable message
 */
message: string, };

export type FlashStage = "downloading" | "extracting" | "writing" | "verifying" | "finalizing" | "uploading" | "creating_vm" | "starting_vm" | "complete" | "error";

export type DeviceManifest = {
/**
 * Version of the manifest format
 */
version: number,
/**
 * List of supported devices
 */
devices: Array<Device>, };

export type Device = {
/**
 * Unique device identifier
 */
id: string,
/**
 * Human-readable name
 */
name: string,
/**
 * Device category
 */
category: DeviceCategory,
/**
 * Image URL for the device photo
 */
image_url: string | null,
/**
 * HAOS image configuration
 */
haos: HaosConfig, };

export type DeviceCategory = "raspberry_pi" | "odroid" | "khadas" | "asus" | "home_assistant_hardware" | "generic_x86" | "generic_arm64";

export type HaosConfig = {
/**
 * Board identifier for the HAOS image
 */
board: string,
/**
 * Download URL template
 */
download_url: string,
/**
 * Minimum nominal target capacity in decimal bytes, with 5% reserved-space allowance.
 */
minimum_storage_bytes: number,
/**
 * Recommended nominal target capacity in decimal bytes, with the same allowance.
 */
recommended_storage_bytes: number, };

export type FlashRequest = {
/**
 * Target device ID (block device path)
 */
device_id: string,
/**
 * Board identifier (e.g., "rpi5-64", "green")
 */
board: string,
/**
 * Whether to verify after writing
 */
verify: boolean,
/**
 * What the device at `device_id` looked like when the user selected it
 */
expected_device: ExpectedDevice, };

export type ExpectedDevice = { size?: number | null, model?: string | null, vendor?: string | null, serial?: string | null, };

export type HaosRelease = {
/**
 * Version string (e.g., "16.3")
 */
version: string,
/**
 * List of available images
 */
images: Array<HaosImage>, };

export type ImageFormat = "raw" | "qcow2";

export type HaosImage = {
/**
 * Board name (e.g., "rpi5-64", "green", "generic-x86-64")
 */
board: string,
/**
 * Disk format of the image
 */
format: ImageFormat,
/**
 * Download URL
 */
download_url: string,
/**
 * File size in bytes
 */
size: number,
/**
 * GitHub's digest of the compressed asset. Required for installation.
 */
digest: string | null, };

export type FlashResult = {
/**
 * Duration in seconds
 */
duration_secs: number, };

export type ProxmoxCredentials = {
/**
 * Proxmox server URL (e.g., https://192.168.1.100:8006)
 */
server_url: string,
/**
 * Username (e.g., root@pam)
 */
username: string,
/**
 * Password
 */
password: string,
/**
 * Optional time-based one-time password from an authenticator app.
 */
totp?: string | null,
/**
 * Explicitly confirmed SHA-256 leaf certificate fingerprint, for this login only.
 */
certificate_sha256?: string | null, };

export type ProxmoxSession = {
/**
 * Server URL for the session
 */
server_url: string,
/**
 * Authentication ticket
 */
ticket: string,
/**
 * CSRF prevention token
 */
csrf_token: string,
/**
 * Certificate approved at login; enforce it for every request in this session.
 */
certificate_sha256?: string | null, };

export type ProxmoxNode = {
/**
 * Node name
 */
name: string,
/**
 * Node status (online/offline)
 */
status: string,
/**
 * CPU usage percentage
 */
cpu_usage: number | null,
/**
 * Memory usage in bytes
 */
memory_used: number | null,
/**
 * Total memory in bytes
 */
memory_total: number | null, };

export type ProxmoxBridge = { name: string, network_type: string, comments: string | null, };

export type ProxmoxStorage = {
/**
 * Storage name
 */
name: string,
/**
 * Storage type (local, nfs, cifs, etc.)
 */
storage_type: string,
/**
 * Content types (images, rootdir, iso, etc.)
 */
content: Array<string>,
/**
 * Available space in bytes
 */
available: number,
/**
 * Total space in bytes
 */
total: number,
/**
 * Whether storage is active
 */
active: boolean, };

export type ProxmoxVmConfig = {
/**
 * Target node name
 */
node: string,
/**
 * Target storage name
 */
storage: string,
/**
 * Network bridge or SDN VNet selected on the target node
 */
bridge: string,
/**
 * VM ID (e.g., 100)
 */
vm_id: number,
/**
 * VM name
 */
name: string,
/**
 * Number of CPU cores
 */
cpu_cores: number,
/**
 * Memory in MB
 */
memory_mb: number,
/**
 * Disk size in GB
 */
disk_size_gb: number,
/**
 * Whether to start VM after creation
 */
auto_start: boolean, };

export type ProxmoxVmResult = {
/**
 * The created VM ID
 */
vm_id: number,
/**
 * Node where VM was created
 */
node: string, };

export type UtmVmConfig = {
/**
 * VM name
 */
name: string,
/**
 * Path to the HAOS qcow2 image file
 */
image_path: string,
/**
 * Number of CPU cores
 */
cpu_cores: number,
/**
 * Memory in MB
 */
memory_mb: number,
/**
 * Disk size in GB
 */
disk_size_gb: number,
/**
 * Whether to start VM after creation
 */
auto_start: boolean, };

export type UtmVmResult = {
/**
 * UTM's unique identifier, used for subsequent status and start commands
 */
id: string,
/**
 * The created VM name
 */
name: string,
/**
 * Path to the VM bundle
 */
path: string | null, };

export type UtmStatus = {
/**
 * Whether UTM is installed
 */
installed: boolean,
/**
 * UTM version if installed
 */
version: string | null,
/**
 * Path to UTM application
 */
path: string | null, };

export type SystemInfo = {
/**
 * Number of logical CPU cores.
 */
cpu_cores: number,
/**
 * Total memory in megabytes.
 */
memory_mb: number, };

export type VmStatusInfo = {
/**
 * VM run status (e.g. "started", "unknown").
 */
status: string,
/**
 * The VM's IP address, if known.
 */
ip_address: string | null, };
