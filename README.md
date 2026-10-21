# Harmattan WebFlasher

N9 / N950 flasher in the browser.

Browser-based replacement for Nokia's `flasher` 3.12 (MeeGo Harmattan) for the N9 (RM-696) and N950 (RM-680), built on WebUSB. Protocol details are in [PROTOCOL.md](PROTOCOL.md).

Status: the protocol code is unit-tested against fake devices only. Treat first runs on real hardware as experimental, and start with read-only *Identify*.

## Quick start

```sh
sudo cp udev/70-nokia-flasher.rules /etc/udev/rules.d/
sudo udevadm control --reload && sudo udevadm trigger --subsystem-match=usb
npm run serve            # python3 serve.py 8000 (localhost only, no caching)
chromium http://localhost:8000
```

Unplug and replug the phone after installing the rule. Click **Connect…**, pick the Nokia device, then **Identify**.

## 1. udev rule (Linux)

Chromium needs read/write access to `/dev/bus/usb/<bus>/<dev>`. By default that node is `root:root 0664`, so WebUSB reports "Access denied" / `SecurityError: Failed to open the device`.

`udev/70-nokia-flasher.rules`:

```udev
SUBSYSTEM=="usb", ENV{DEVTYPE}=="usb_device", ATTR{idVendor}=="0421", TAG+="uaccess", ENV{ID_MM_DEVICE_IGNORE}="1"
SUBSYSTEM=="usb", ENV{DEVTYPE}=="usb_device", ATTR{idVendor}=="0451", ATTR{idProduct}=="d009", TAG+="uaccess", ENV{ID_MM_DEVICE_IGNORE}="1"
SUBSYSTEM=="usb", ENV{DEVTYPE}=="usb_device", ATTR{idVendor}=="0451", ATTR{idProduct}=="d00e", TAG+="uaccess", ENV{ID_MM_DEVICE_IGNORE}="1"
```

- `0421:*` covers every Nokia mode the flasher touches: NOLO `0105`, cold-flash USB ROM `0106`, the Phonet/SU interface, sync mode `03d2`/`051a`.
- `0451:d009` / `0451:d00e` are the TI OMAP boot ROM IDs used for cold flash. Only these two TI products are matched, not all of TI.
- `TAG+="uaccess"` gives the user logged in on the active seat an ACL on the device node (systemd-logind). No group membership or `sudo` is needed. It also applies to the *new* device node created every time the phone re-enumerates, which happens several times during a flash.
- `ID_MM_DEVICE_IGNORE` stops ModemManager from probing the phone mid-flash.

Install and apply:

```sh
sudo cp udev/70-nokia-flasher.rules /etc/udev/rules.d/
sudo udevadm control --reload
sudo udevadm trigger --subsystem-match=usb --action=add
```

then replug the phone (already-enumerated devices are only re-labelled by the `trigger` step, replugging is the sure way). Check:

```sh
lsusb | grep -E '0421|0451'             # find bus/device number
getfacl /dev/bus/usb/<bus>/<device>     # should list user:<you>:rw-
udevadm info -q property -n /dev/bus/usb/<bus>/<device> | grep -E 'TAGS|CURRENT_TAGS'   # contains uaccess
```

Notes:
- `uaccess` needs a logind seat session. For ssh/headless setups, use `GROUP="plugdev", MODE="0660"` instead of the tag and add yourself to that group (create the group if your distro has none).
- Flatpak/Snap Chromium builds are sandboxed and may not see `/dev/bus/usb` at all. Use a native package. (Arch `chromium` and Google Chrome both work.)
- The rule changes only permissions. The kernel's `cdc_phonet` driver stays bound until the browser claims the interface (see limitations).

## 2. Serving the app

WebUSB works only in a *secure context*: `https://…` or `http://localhost` / `http://127.0.0.1`. The page is static, with ES modules, so it must be served over HTTP (opening `index.html` via `file://` does not work).

Local use (recommended):

```sh
npm run serve        # python3 -m http.server 8000 --bind 127.0.0.1
# open http://localhost:8000 in Chromium
```

Binding to `127.0.0.1` keeps it private. For another machine on your LAN you need HTTPS (for example `caddy file-server --listen :8443` with a locally trusted certificate such as one from `mkcert`), because a plain-HTTP LAN address is not a secure context.

Supported browsers: Chromium-based (Chrome, Chromium, Edge, Brave, Opera). Firefox and Safari have no WebUSB.

## 3. Using it

1. Put the phone in a flashing USB mode (see the *Which USB mode is which?* hint in the UI). **Identify** is safe in all of them.
2. **Connect…**, choose the device, **Identify**. Expect a NOLO version and product/hardware revision.
3. Load FIASCO files (N9: main image plus eMMC image). Untick what you don't want, or use the **Flash only** groups (`--flash-only`: `nolo` = xloader + secondary, `kernel`, `moslo`, `rootfs`, `cmt`, `mmc`, `tar`; **MMC only** = `-M`), then **Flash selected**. `config` images are left unticked, because the original never flashes them.
4. Whenever the phone reboots/re-enumerates (after loading the APE algorithm, after cold flash), the page waits for it. Chromium only remembers a device it has seen before when the device has a serial number. If the page shows *Select device…*, click it once and pick the new entry.

## 4. Limitations vs. the native tool

| Area | Native `flasher` | Web version |
|------|------------------|-------------|
| Kernel driver | Detaches `cdc_phonet` with `usb_detach_kernel_driver_np` | Chromium on Linux detaches non-`usbfs` drivers when you claim an interface. This is expected to work for `cdc_phonet`, but is **untested here**. If `claimInterface` fails with "Unable to claim interface", run `echo -n <usb-path>:1.1 | sudo tee /sys/bus/usb/drivers/cdc_phonet/unbind` (or `rmmod cdc_phonet`) once. |
| Protected classes | none | WebUSB refuses HID, mass storage, audio, video, smart-card and a few other classes. The Phonet (CDC) and vendor-class interfaces used here are not on that list. Mass-storage mode (`0421:0518`) is irrelevant. |
| USB timeouts | libusb timeouts cancel the transfer | WebUSB can't cancel a transfer. A timed-out bulk read stays in flight and is handed to the next read, so data isn't lost, but a *stuck* transfer can only be cleared by unplugging. |
| `usb_reset`, device-by-bus selection (`-U`) | supported | not available. The browser's device chooser replaces `-U`. |
| Zero-length packets | sent after 512-byte multiples | done explicitly in `SuClient`; the browser does not add them for you. |
| Re-enumeration | rescans bus | needs a fresh permission when the new device has no serial number (see step 4 above). |
| Serial / `-S` cold flash | deprecated in the original too | not supported. USB only. |
| CAL backup (`SU_READ_CONFIG`), certificates, `--erase-*` options not listed in the UI | partially hidden CLI options | the protocol client has `readConfig` and erase; CAL backup and certificate commands have no UI. |
| Parallel image programming | flashes MMC and NAND images concurrently | images are flashed one at a time (slower, possibly rejected by some server versions). |
| Large files | streamed from disk | the FIASCO is read fully into memory, so a multi-GiB eMMC image needs matching RAM. |
| Cold flash with several `2nd` images | boots the matching `1st` image, queries the HWID, then picks the `2nd`/`ape-algo` for that HW | not supported: refused with the original's "supply 1st image OR specify hardware type" error. A FIASCO with a single `2nd` works. |
| Plain (non-FIASCO) images | `-k`, `-n`, `-r`, `-a` accept raw images | only FIASCO files are parsed. Use `fiasco-gen`/`0xFFFF` to wrap raw images first. |

## 5. Development

```sh
npm test      # node --test, no dependencies
```

Layout: `src/protocol.js` (pure protocol), `src/fiasco.js` (parser), `src/flasher.js` (operations over an abstract host), `src/webusb.js` (the only browser-USB code), `src/app.js` (UI), `test/fakes.js` (simulated SU server, NOLO, boot ROM).

## 6. Credits and legal

- Licensed under the [MIT License](LICENSE). Not affiliated with or endorsed by Nokia.
- Protocol knowledge comes from observing the behaviour of Nokia's `flasher` 3.12.1 for interoperability, cross-checked against the open-source [0xFFFF](https://github.com/pali/0xFFFF) project by Pali Rohár (GPLv3). No code was copied from either; this is an independent implementation of the same wire protocols.
- Verified on real hardware so far: N9 (RM-696) identify in PC Suite mode, ADL reboot into NOLO, NOLO identify, reboot. Flashing itself is not yet verified on hardware.
- Troubleshooting: if Connect fails with `Unable to claim interface`, another program owns the phone. A VirtualBox USB filter for vendor `0421` ("Captured" in `VBoxManage list usbhost`) is a common cause. Disable the filter or stop the VM; it would also re-capture the phone every time it re-enumerates.
