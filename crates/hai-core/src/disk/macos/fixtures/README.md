# Diskutil safety fixtures

These are reduced, constructed `diskutil info -plist` fixtures, not fresh
hardware captures. Their field names and APFS relationships follow recorded
diskutil output in [Asahi installer issue 141](https://github.com/AsahiLinux/asahi-installer/issues/141).
The disk image fields follow the recorded plist observations in
[tacklebox issue 108](https://github.com/tuna-os/tacklebox/issues/108).

The device numbers and removable flags model an external USB boot disk:
root snapshot and Data volume -> APFS container `disk3` -> physical store
`disk2s2` -> whole USB disk `disk2`. The same USB disk is a valid target when
it does not hold a running system volume. Tests mutate this topology for
multiple stores, missing metadata, HFS, and built-in SD readers.

In the machine-readable plist, `VirtualOrPhysical` is a string (including
`Unknown` on real physical disks); `Virtual: Yes` is the human-readable
output. Entries in `APFSPhysicalStores` use `APFSPhysicalStore`, not
`DeviceIdentifier`.
