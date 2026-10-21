# Nokia N9 / N950 flashing protocol notes

Interoperability notes for a WebUSB reimplementation of Nokia's `flasher` 3.12.1 (Oct 5 2011, Harmattan) for the N9 (RM-696) and N950 (RM-680).

**Sources and confidence tags**

| Tag | Meaning |
|-----|---------|
| **[bin]** | Read from the `flasher` binary (Ghidra decompile of the x86-64 build, plus data tables dumped from `.data`/`.rodata`). Highest confidence. |
| **[0xFFFF]** | Taken from the open-source 0xFFFF sources in `./0xFFFF/src` and cross-checked against the binary where marked **[bin+0xFFFF]**. |
| **[infer]** | Inferred from code structure. Needs confirmation against a real device or a USB capture. |

0xFFFF implements cold-flash, NOLO and FIASCO parsing. Its Mk II (`mkii.c`) flasher is a stub (`flash_image` returns "Not implemented yet"). The part of the real flasher that actually flashes Harmattan (the "softupd" / SU protocol over Phonet/ISI) is **not** in 0xFFFF, so section 5 comes from the binary alone and is the least cross-checked. Treat it as the main risk area.

Build facts: ELF64, dynamically linked against `libusb-0.1` and `librt`, stripped except for dynamic symbols (`nolo_devices`, `bootrom_devices`, `flasher_opts`, `su_set_rd_flags`, `common_*_cert`). No commands exist outside the CLI options below.

---

## 0. CLI surface (`flasher --help`) **[bin]**

```
-F fiasco   -a ape-algo   -k kernel   -L moslo   -n initfs   -r rootfs
--cmt-2nd --cmt-algo --cmt-mcusw
-i read-device-id    -f flash    -l load only    -b[cmdline] boot    -R reboot
-c cold-flash
--enable-rd-mode --disable-rd-mode --set-rd-flags=F --clear-rd-flags=F --query-rd-mode
--flash-only=LIST   -M flash-only-mmc
-U bus[:addr] | s:<usb serial> | S:<serial>
--erase-user-data[=secure]   --erase-mmc[=secure]
--no-preserve  -v trace  --quiet  --suppress-warranty-warning
-O<opt>  (hidden: wait-charging, no-cmt-rfs, ...)
```

Image names recognised (table at `0x61fc80`) **[bin]**: `cert-sw`(0x4000) `cmt-2nd`(0x10) `cmt-algo`(0x20) `cmt-mcusw`(0x40) `xloader`/`secondary`(0x1) `kernel`(0x2) `moslo`(0x80) `rootfs`(0x8) `mmc`(0x100) `tar`(0x200) `config`(0x2000). Also handled in the FIASCO/NOLO paths: `1st`, `2nd`, `ape-algo`(0x1000), `initfs`(4), `initrd`.

The flash mask starts at `0x3ff` (`0x402bce`): every main image and the CMT images, but not `config` (0x2000), which no option can select. `cert-sw` is added later (5.6).

`--flash-only=LIST` (`FUN_004026e6`, names at `0x6202a0`): `nolo`(0x1, xloader/secondary) `kernel`(0x2) `moslo`(0x80) `initfs`(0x4) `rootfs`(0x8) `cmt`(0x70) `mmc`(0x100) `tar`(0x200), comma separated. An unknown name prints `Valid --flash-only options:` and exits with 2. `-M` (`--flash-only-mmc`) ORs in `mmc`. The list is ANDed with the flash mask (`0x40387c`), and `cert-sw` is then added only if a `0x38F` bit is left (5.6), so `--flash-only=cmt` flashes no cert-sw.

---

## 1. Operating flow (what `main` does) **[bin]**

```
parse args → read FIASCO / user images → build raw subblock blobs
if -c:  COLD FLASH  (bootrom, 0x0421:0x0106 or 0x0451:0xD009/D00E)   -> section 3
        sends 2nd + ape-algo/secondary into RAM; device re-enumerates
open USB, matching transports bootrom|bootloader|phonet (-U filter applies)
if the interface is Phonet (SU server already running):  go to SU        -> section 5
else (NOLO, 0x0421:0x0105):                                              -> section 4
    NOLO identify (prod_code, hw_rev, NOLO version)
    upload ape-algo (mask 0x1000) with NOLO SEND_IMAGE
    "change protocol": NOLO BOOT (cmdline " ")  -> device boots ape-algo
    close, re-enumerate, find Phonet interface, ping, init SU
SU: optional erase (--erase-mmc / --erase-user-data), set rd-mode, flash images,
    state change reboot / boot, "Success"
exit codes: 0 ok, 1 bad image args, 2 bad CLI, 3 no device/interface, 4 flashing failed
```

If `-f` is requested without an ape-algo the tool prints "APE algorithm has to be provided to flash all the subimages". Everything except `--cold-flash` and `--boot`/`--reboot` of an already-running NOLO needs the APE algorithm (an SU server) running on the device.

---

## 2. USB discovery and interfaces

### 2.1 Device tables **[bin]** (dumped from `.data`)

`nolo_devices`:

| VID:PID | iface | alt | role |
|---------|-------|-----|------|
| 0421:0105 | 2 | 1 | NOLO (bootloader, "Update mode") |

`bootrom_devices`:

| VID:PID | iface | alt | role |
|---------|-------|-----|------|
| 0451:D009 | 0 | 0 | TI OMAP boot ROM (**N9 / N950 cold flash**, new in 3.12) |
| 0451:D00E | 0 | 0 | TI OMAP boot ROM (variant) |
| 0421:0106 | 0 | 0 | Nokia "USB ROM" cold-flash mode |

0xFFFF **[0xFFFF]** agrees on 0421:0105 (iface 2, alt 1) and 0421:0106 (iface 0, alt 0). It does not list 0451:D009/D00E.

`Phonet` (SU) interfaces are **not** matched by a PID list. They are matched structurally (`FUN_004144f4`, `FUN_00414203`):

1. `idVendor == 0x0421`, device class `0x02` (CDC) or `0xEF` (misc).
2. A communications interface (class 2, subclass `0xFE`) carrying CDC functional descriptors:
   - subtype `0xAB` (Phonet header) whose first bytes are `05 15`;
   - then subtype `0x00` (the standard CDC Header, `bcdCDC` bytes `10 01` = 1.10; first byte must be ≥ `0x10`, second `01`) — verified on a real N9 in PC Suite mode;
   - then subtype `0x06` (union), whose slave interface number is the **data interface**.
3. The data interface must have an alt setting with more than one endpoint. The first IN-direction endpoint is the ISI read EP, the first OUT is the ISI write EP (low nibble taken as the EP number, `0x80` OR'd in for reads). 0xFFFF hardcodes these as EP1 IN / EP1 OUT **[0xFFFF]**.
4. Separately (`FUN_00414330`): an interface with class `0xFF`, subclass 0, protocol 0, 1–2 endpoints, whose bulk **OUT** endpoint becomes the **raw data EP** (EP2 in 0xFFFF's NOLO). Log line: `Raw data transfer EP found at EP%d.`

Known 0421 PIDs (0xFFFF `usb-device.c`) **[0xFFFF]**: 0x01c8 (N900 / N950 Mk II), 0x03d2 (N950 update), 0x051a (N9 sync mode, ADL), 0x0518 (N9 mass storage), 0x0519 (N9 RNDIS). The binary treats 0x03d2 and 0x051a as "Sync and connect mode" and sends an **ADL reboot** first (section 5.7).

### 2.2 Opening **[bin]**

- Kernel driver handling: if `usb_get_driver_np` reports `cdc_phonet`, the tool detaches it (`Could not detach kernel driver` on failure), then `usb_claim_interface`, then `usb_set_altinterface` when alt > 0. Retry 10 times at 100 ms when claiming fails with `-2`.
- Reads the device serial string. The serial is hex-encoded ASCII (`FUN_00414b57`, `%2x` pairs, ≤512 bytes). Printed as `Device identifier: %s (SN: %s)`.
- Waiting loop: `Suitable USB interface (%s) not found, waiting...` re-scans every 10 ms.
- Bulk transfer helper (`FUN_004152dd`) loops until the full buffer is written. Bulk read maps `-110` (timeout) to `-6`, `EACCES` to `-5`.
- **ISI write quirk** (`FUN_00415497`): after a bulk OUT whose length is a multiple of 512, send a **zero-length packet**.

---

## 3. Cold flash (OMAP boot ROM → X-Loader) **[bin+0xFFFF]**

Used with `-c`. Transport: bulk IN `0x81`, bulk OUT `0x01` on interface 0, alt 0.

1. **Read ASIC ID.** `bulk read` on the IN EP (max 0x100, timeout 500 ms). At least 0x45 (69) and at most 0x80 bytes are accepted. 0xFFFF expects exactly 69. The boot ROM sends the ASIC ID **once** per enumeration, so a client that reads it early (e.g. for an identify step) must keep it for the cold flash instead of reading again. Layout **[0xFFFF]**:
   - `[0]=0x05` subblock count
   - `[1..3]=01 05 01` ID subblock
   - `[4..6]` chip: `34 30 07` = OMAP3430, `36 30 07` = OMAP3630
   - `[7]` revision
   - `[8..10]=13 02 01` secure mode
   - `[12..14]=12 15 01` 2nd ID
   - `[35..37]=14 15 01` root key hash
   - `[58..60]=15 09 01` checksum
   - The `-c` path (`FUN_0040e6f8` via `FUN_0040db1f`) checks only the length (0x45..0x80) and hex-dumps the ID; it does **not** classify it.
   - `FUN_0040d80c` classifies the secure-mode magic: `13 02 01 01` → 3 (EMU); `13 02 01 00` → 1 (GP) when the 20-byte root key hash at `[38..57]` is all zero, else 2 (HS); any other magic prints "Unknown magic in ASIC ID" and returns −1. A hash prefix other than `14 15 01` only prints "Warning: unknown hash prefix in ASIC ID". Its only caller is the 1st-image HW detection (`FUN_00409e09`), which prints `HW variant: %s` from the name table at `0x61fb60` (`unknown`, `GP`, `HS`, `EMU`), prints "Unknown HW variant" for anything else and carries on. `FUN_0040d93f` compares the 20-byte root key hash against two known tables (device type lookup). The web version shows the variant (`unknown` for other magics) and never stops on it.
2. **Send 2nd stage ("1st image")**. Bytes sent, in order, with 10 ms sleeps between:
   - `02 00 03 f0` (OMAP peripheral boot message `0xF0030002`, little endian; stored at `0x419fa1`)
   - `u32 LE length`
   - the image bytes (single bulk write loop, 3000 ms timeout)

   After the write, wait 50 ms.
3. **X-Loader messages** (16 bytes each). All integers are little-endian:

   | off | size | field |
   |-----|------|-------|
   | 0 | u16 | magic `0x326E` |
   | 2 | u16 | command |
   | 4 | u32 | payload size |
   | 8 | u32 | CRC32 of the payload (0 when none) |
   | 12 | u32 | CRC32 of bytes 0..11 |

   CRC32 here is the standard reflected polynomial `0xEDB88320` table-driven update with **initial value 0 and no final inversion** (table at `0x41a060`; matches 0xFFFF's `crc32`).

   | command | meaning |
   |---------|---------|
   | `0x6301` | ping |
   | `0x6302` | send secondary |
   | `0x6304` | send ape-algo (new in 3.12) |
   | `0x6305` | HWID query (reply ≤32 bytes, printed as `Received %d bytes from 1st`) |

   After the 16-byte header the device replies with a 4-byte word: `0x00006FAA` means OK. A value whose low byte is `0xAA` is an error code (error = `-(word & 0xFFFF)`). Replies are read with 500 ms timeout for the header acknowledgement and 5000 ms after the payload. Payload is sent in chunks of at most `0x10000`; the device acknowledges once more with `0x6FAA`.
4. **Sequence** (`-c`, `FUN_0040e30b`): read ASIC ID → send 2nd → wait 50 ms (the transport's pre-ping hook `FUN_0040e94e`, run once) → ping (up to 4 tries) → send ape-algo (`0x6304`, up to 3 tries) → close. The 2nd and ape-algo payloads (and the 2nd length word) use the 128-byte-padded, `0xFF`-filled size (6.2). The separate "1st image" path (`FUN_0040e573`) sends 1st → waits 50 ms → HWID query (up to 4 tries, then drains pending input). The 3.12 binary never sends the OMAP *memory boot* message `00 00 00 00` (that is 0xFFFF only); closing the transport (`FUN_0040e96b`) just releases the device. Outside `-c` the tool does not open boot ROM devices at all (other operations scan only for NOLO/Phonet), so there is no reboot or boot in this mode.

Cold flash requires `2nd` and `ape-algo` images (`You have to supply the 2nd image for %s:%s`, `You have to supply the ape-algo image`). Without device info, the first image of each type in the FIASCO is used (6.3).

---

## 4. NOLO bootloader protocol (0421:0105) **[bin+0xFFFF]**

Pure vendor control transfers on EP0 plus bulk OUT on EP2 for payloads. Interface 2, alt setting 1.

`bmRequestType`: `0x40` = host→device (write), `0xC0` = device→host (query). Default timeout 2000 ms. **Timeouts differ per request: `0x50`→10 s, `0x52`→30 s.**

| bRequest | dir | wValue | wIndex | data | purpose |
|----------|-----|--------|--------|------|---------|
| `0x01` GET_STATUS | in | 0 | 0 | 4 bytes | loop of 2 reads that only ends early on a 0-byte reply, so a normal 4-byte reply means it is sent **twice**; a stall counts as one try; the last read must return exactly 4 bytes; the value is not checked (`FUN_0040aceb`, verified in the disassembly at `0x40aceb`). 0xFFFF polls until 0. The web version reads once (plus one retry after a stall); the value is ignored either way |
| `0x03` GET_NOLO_VERSION | in | 0 | 0 | 4 bytes | `major=v>>20&15, minor=v>>16&15, patch=v>>8&255`; `(v&0xFF) >= 2` = "Invalid flashing API version" |
| `0x04` IDENTIFY | in | 0 | 0 | ≤512 | device info blocks (below) |
| `0x05` ERROR_LOG | in | 0 | 0 | ≤0x800 | NUL-separated strings; sent after any failed request (`-ENODEV` style `-0x20` = pipe stall) |
| `0x10` SET | out | value | index | – | index 0 rd-mode, 1 root device, 2 USB host mode, 3 add rd flags (u16), 4 delete rd flags (u16) |
| `0x11` GET | in | 0 | index | 1/2/4 B | same indices |
| `0x12` STRING | out | 0 | 0 | key | select a named string |
| `0x13` SET_STRING | out | 0 | 0 | value | set selected string |
| `0x14` GET_STRING | in | 0 | 0 | ≤0x3ff | read selected string. Used as `get("key")` = `0x12` then `0x14` |
| `0x42` SEND_IMAGE | out | 0 | 0 | **subblock blob** | announce an image to be loaded to RAM (kernel, ape-algo, …) |
| `0x54` SEND_FLASH_IMAGE | out | 0 | 0 | subblock blob | announce an image that is flashed directly (**rootfs**) |
| bulk OUT EP2 | out | – | – | image bytes | chunked ≤0x20000, 5000 ms per write |
| `0x52` FINISH_FLASH | out | 0 | 0 | – | after a `0x54` transfer; 30 s |
| `0x50` FLASH_IMAGE | out | 0 | index | – | flash an already-sent kernel(3)/secondary(1)/cmt(0x42) (0xFFFF only; the 3.12 binary has no call for `0x50` besides the timeout special case) |
| `0x60` ASIC_SELECT | out | value | index | – | route to an ASIC (used by cert and challenge/response) |
| `0x61` ASIC_WRITE | out | value | index | msg+checksum | send an ASIC message; checksum = `~(sum of bytes 1..n-1)` (`FUN_0040ba73`) |
| `0x62` ASIC_READ | in | 0 | offset | ≤0x1000 | read response in 0x1000-byte windows (wIndex = offset) |
| `0x82` BOOT | out | mode | 0 | cmdline | `mode 0` = boot kernel with optional cmdline; `mode 1` = reboot into flash mode |
| `0x83` REBOOT | out | 0 | 0 | – | plain reboot (refused when a boot mode is requested) |

Identify blocks (`FUN_0040d5d8`): repeated `{ char name[14]; u16 len; u8 data[len] }` records. The record header is 16 bytes with the length at offset 14. `len` must be a multiple of 4. The tool reads `prod_code` (e.g. `RM-696`) and `hw_rev` (decimal string). `sw-release` / `kernel` / `initfs` / `nolo` / `content` versions come from `STRING`/`GET_STRING` with key `version:<name>` **[0xFFFF]**.

NOLO init (`FUN_0040b069`) fails, and nothing else is done over NOLO, when: the status read fails, `prod_code` is missing ("Product code not found"), `hw_rev` is missing ("HW revision not found"), GET_NOLO_VERSION fails or does not return exactly 4 bytes ("Unable to get bootloader version" / "Bootloader might be too old"), or the API byte is ≥ 2. Only the `version:sw-release` string is optional.

**R&D setter gate**: the NOLO context is set up with its R&D setter slot (`ctx+0x38`) empty and `FUN_0040d1da` in `ctx+0x40` (the query hook). `FUN_0040b069` then does `ctx[7] = ctx[8]` when the NOLO version (`v >> 8` of the whole word, signed `sar` at `0x40b16f`, so not masked to major/minor/patch: a non-zero top byte counts too) is **outside** `0x1509…0x1604` (1.5.9 – 1.6.4). So outside that window NOLO can *set* R&D mode and flags itself (section 5.8); inside it, setting them needs the APE algorithm.

**Loading ape-algo** (`FUN_0040b91d` with mask 0x1000): `SEND_IMAGE(0x42, blob)` → bulk write of the 128-byte-padded, `0xFF`-filled payload (6.2), in chunks of ≤ 0x20000 → done. The extra `usleep(100 ms)` after the data. Kernel/initfs identical (masks 2 / 4). CMT images (`cmt-2nd`, `cmt-algo`, `cmt-mcusw`) are sent in that order with the same procedure.

**Load and boot** (`-k kernel [-n initfs] -l -b[cmdline]`): kernel then initfs are sent with the same SEND_IMAGE procedure, then `BOOT(0x82, mode 0, cmdline)`; nothing is written to flash. The web version does this as *Load & boot kernel*, NOLO only.

**Change protocol** (`FUN_0040a4ea` with `param_5 = 1`): `BOOT(0x82, mode 0, cmdline " ")` (a single space). The device boots the freshly-loaded ape-algo, drops off the bus, and reappears with the Phonet interface. The host closes the NOLO handle, rescans with transport mask 4 (phonet) (the scan loop waits indefinitely until the interface appears), then runs SU init.

---

## 5. ISI / Phonet "softupd" (SU) protocol — the Harmattan flasher **[bin]**

### 5.1 Framing

Phonet/ISI over USB bulk. Messages go out on the ISI-write EP and replies come in on the ISI-read EP (read buffer 0x10004 bytes; reply must be ≥10 bytes and total length ≥ `len+6`).

```
byte  0   media        0x1B  (USB)
byte  1   receiver dev 0x00  (phone/APE)         request
byte  2   sender dev   0x10  (PC)
byte  3   resource     0x88  (SU)  [0x6F for ADL]
byte  4-5 length BE    = total_bytes - 6   (payload_len + 4)
byte  6   receiver obj 0x00
byte  7   sender obj   0x00
byte  8   transaction id   (per-message counter, starts at 0)
byte  9   message id
byte 10…  payload
```

A response swaps bytes 1/2 and 6/7 and has the same transaction id. The host accepts a reply only when `reply[2]==req[1] && reply[1]==req[2] && reply[6]==req[7] && reply[8]==req[8]`; otherwise `-EINVAL`. **[bin+0xFFFF]**: 0xFFFF's `MKII_OUT = 0x8810001B` and `MKII_IN = 0x8800101B` are exactly the first four bytes of this header (little-endian u32). A bulk OUT whose size is a multiple of 512 is followed by a zero-length packet.

The original does exactly **one** bulk read per request (`FUN_00415b6c`). A reply with the wrong transaction id or addresses fails the request with `-EINVAL`; a read timeout (`-6`) or an empty read is reported as `%s_REQ timed out`. **Web version deviation (deliberate):** a WebUSB read can't be cancelled, so a reply to a request that timed out earlier (e.g. a ping) arrives on a later read. The web client skips replies whose transaction id or addresses don't match and keeps reading until its own timeout.

Response id = request id | `0x20` for every SU message. Special replies:
- msg id `0xFF` from resource 0x88: "Server in failure mode: internal error or bad HW. Cannot continue".
- msg id `0xF0` (COMMON_MESSAGE): CMT-originated notification; sub-id in payload byte 0. Logged at verbosity 1, but the request still fails with `-4` (the same code as any unexpected reply; during the ping loop this triggers the ADL reboot). A reply whose transaction id or addresses don't match the request is rejected with `-EINVAL`, not skipped.

Most replies carry a **status byte**. Position in the payload is per message (table below). Status codes: 0 ok, 1 unknown error, 2 invalid args, 3 invalid state, 4 out of memory, 5 object exists, 6 not supported, 7 not found, 8 too large, 9 unknown request, 10 security failure, 11 (0x0B) battery low. If the status byte is not the last byte, the remaining bytes are a NUL-terminated error string printed under `=== Detailed error info===`.

All multi-byte integers inside SU payloads are **big-endian** (`FUN_0040eed8` = BE32, `FUN_0040ef7e` = BE64).

### 5.2 Message table

| id | name | request payload | reply min length / status index |
|----|------|-----------------|--------------------------------|
| `0x00` | VERIFY_COMMS (ping) | echo bytes (empty for ping) | echoed back; reply `0x20` |
| `0x01` | GET_PARAMETER | key (no NUL) | status byte 0, then value string (len−1 bytes) |
| `0x02` | SET_PARAMETER | key `\0` value | 1 byte, status 0 |
| `0x03` | BEGIN_UPDATE | – | status 0; code −9 (battery low) → charging message |
| `0x04` | BEGIN_IMAGE_UPDATE | **subblock blob** (section 6.3) | ≥9 B: `u32 pipe_id, u32 block_size, status@8` |
| `0x05` | SETUP_AUX_DATA_PIPE | `u32 pipe_id` + `"usb:raw"` (no NUL) | status 0 |
| `0x06` | GET_UPDATE_STATUS | `u32 pipe_id` | ≥21 B: `u32 state(+flag), u64 done, u64 total, status@20` |
| `0x08` | PREPARE_DATA_BLOCK | `u32 pipe_id, u32 length` | status 0 |
| `0x09` | FEED_DATA_BLOCK | `u32 pipe_id` + data (≤ `0x8000` per message, or `-O` override) | status 0 |
| `0x0A` | FINISH_IMAGE_UPDATE | `u32 pipe_id` | status 0 |
| `0x0B` | WAIT_FOR_BUFFER | `u32 timeout_ms` | `u32 n, n×{u32 pipe_id, u32 bytes_free}, status` |
| `0x0C` | DEVICE_STATE_CHANGE | 16-byte NUL padded string (below) | status 0 |
| `0x0D` | BANDWIDTH_TEST | – | – (defined, unused by normal flow) |
| `0x0F` | UPDATE_SW_REL | SW-release blob (fiasco header) | status 0 |
| `0x10` | CANCEL_UPDATE | – | status 0 (sent on Ctrl-C) |
| `0x11` | READ_CONFIG | `u32 block_no` | status 0 + data (CAL backup, proto ≥ 1.07) |
| `0x12` | BEGIN_ERASE | `"mmc=secure"`/`"userdata=secure"` `\0` | status 0; 30 min timeout (1800000 ms) |
| `0x1F` | FINISH_UPDATE | – | status 0 |

Default reply timeout 5000 ms. `FEED_DATA_BLOCK` waits 20000 ms. `WAIT_FOR_BUFFER` waits `timeout + 5000` ms.

### 5.3 State values in GET_UPDATE_STATUS **[bin]**

`state & 0xFFFF`: `0` pending, `1` init, `2` erasing, `3` writing, `4` finishing, `0x10` finished. `state & 0x10000` set = **update failed**. When `finished` is seen, the host sends FINISH_IMAGE_UPDATE for that pipe.

### 5.4 Init sequence (`FUN_00412259` → `FUN_00412e99`)

1. Template header `{media 0x1b, rdev 0, sdev 0x10, res 0x88, robj 0, sobj 0}`.
2. If VID:PID is 0421:03D2 or 0421:051A → "Device is in Sync and connect mode, sending ADL reboot" (5.7), re-enumerate.
3. Ping loop: `VERIFY_COMMS` with timeouts 250, 500, 1000, 2000, 4000, 5000 ms (doubling, capped at 5 s), up to 6 attempts (`Ping attempt %d (%d ms)`). Only a timeout leads to another attempt. The reply payload must echo the request exactly (min = max = request length, then `memcmp`, "data verify error"). Any unexpected reply (status `-4`) ends the loop at once → "Unknown response, trying ADL reboot".
4. `GET_PARAMETER /update/protocol_version` → decimal string, e.g. `108`. Must satisfy `106 ≤ v ≤ 108`; `< 106` → "deprecated server" error; `> 108` → "You have to update the flasher client".
5. `SET_PARAMETER /update/host_protocol_version = "108"`.
6. `GET_PARAMETER /update/application_info` (`FUN_00412d98`), printed as `Server application: %s`, parsed as `%u.%u.%u`. Anything below **1.4.8**, or a failed read, aborts with "Refusing to continue: Image contains a deprecated server" ("may overwrite the certificates and render your device unusable").
7. `GET_PARAMETER /device/product_code` (`RM-696`/`RM-680`), `/device/hw_build`, `/update/supported_images` (comma list).
8. Optional `SET_PARAMETER /update/trace_level`.
9. Message printed: `Server implements softupd protocol version %d.%d`.

Protocol-version feature gates: `≥101` cancel update (0x65), `≥102` error list after failure (`> 0x65`), `≥103` CAL read (0x67), `≥104` `no-preserve` (0x68), `≥105` erase (0x69), `≥100` CMT verify flag.

### 5.5 Parameters (GET/SET_PARAMETER keys)

| key | direction | notes |
|-----|-----------|-------|
| `/update/protocol_version` | get | decimal |
| `/update/host_protocol_version` | set | host sends `108` |
| `/update/application_info` | get | "Server application: %s" |
| `/update/supported_images` | get | comma list matching section 0 |
| `/update/error_list` | get | dumped after failure when proto ≥ 102 |
| `/update/trace_level` | set | |
| `/update/no_battery_level_check` | set `1` | only with the `-O` option at `flasher_opts+0x18`; sent before flashing (`FUN_0041155c`) and before BEGIN_ERASE |
| `/update/cmt/verify` | set `1` | proto ≥ 100 unless `-O` skips |
| `/update/cmt/perform_rfs` | set `1` | only when the option at `flasher_opts+4` is set; not sent by default |
| `/update/mmc/no_preserve` | set `0`/`1` | proto ≥ 104; a failure only prints "Unable to set MMC no preserve" and the update goes on (`0x4117cb` ignores the result of `FUN_004139f4`) |
| `/update/nand/part_table/version` | get | copied to ↓ |
| `/device/nand/part_table/version` | set | repartition |
| `/device/product_code`, `/device/hw_build` | get | |
| `/device/hw_build_override` | set | `--hw-revision` style override |
| `/device/battery_level` | get | decimal %. **Not read by default**: the server enforces its own limit, and BEGIN_UPDATE / BEGIN_ERASE then fail with status 11 (`-9`), which prints "BATTERY IS LOW. DEVICE IS NOW CHARGING." and the level. Only with `-Owait-charging` does the host poll it before BEGIN_UPDATE / BEGIN_ERASE, waiting once a second while it is ≤ 10 % ("%d %% required" prints 11). The web version always does that wait before flashing or erasing (until the level is ≥ 11 %, the user aborts or the device is unplugged); its "skip battery check" skips only that local check and does not set `/update/no_battery_level_check` |
| `/device/rd_mode` | get/set | see 5.8 |

### 5.6 Flashing one sub-image (`FUN_004115b1`, `FUN_00411344`)

```
BEGIN_UPDATE
[optional SET_PARAMETERs above]
for each sub-image (scheduler FUN_00410d29 decides when each may start, see below):
    BEGIN_IMAGE_UPDATE(blob)            -> pipe_id, block_size
    [if aux pipe wanted: SETUP_AUX_DATA_PIPE(pipe_id, "usb:raw")]
    repeat until all bytes sent:
        WAIT_FOR_BUFFER(timeout)        -> n bytes free for pipe_id
        chunk = min(remaining, n, 1 MiB rounded down to a multiple of block_size)
        PREPARE_DATA_BLOCK(pipe_id, chunk)
        if aux pipe: bulk-write chunk raw to the raw data EP (5000 ms)
        else:        FEED_DATA_BLOCK messages of ≤ 0x8000 bytes each
        GET_UPDATE_STATUS(pipe_id) periodically  (≥250 ms apart; the WAIT_FOR_BUFFER timeout is
                                                  250 ms minus the time since the last status poll)
    FINISH_IMAGE_UPDATE(pipe_id) once state == finished (0x10)
UPDATE_SW_REL(blob)                      (only when xloader/secondary, kernel, initfs or rootfs was flashed: mask & 0xF)
FINISH_UPDATE
```

Notes:
- The image payload length is padded up to a multiple of 128 bytes (`WARNING: Image '%s' not aligned`); the padding is **`0xFF`** (6.2).
- The aux ("raw") pipe is used for images in group 2 (eMMC rootfs, `mmc`) when a raw data EP was found, never for `tar`. Raw bulk writes retry up to 10 times on `EAGAIN`; zero-length result = "Raw data transfer timed out". If SETUP_AUX_DATA_PIPE fails, its result is ignored and the image is sent with FEED_DATA_BLOCK instead.
- **Per-image failures** (`FUN_00410002`): a failure while the data is sent (WAIT_FOR_BUFFER, PREPARE_DATA_BLOCK, FEED / raw write) or a GET_UPDATE_STATUS that fails or reports the failed bit marks that image failed and every later image of the **same group** skipped. Other groups go on. A failed `cert-sw` stops the update at once. Because nothing but xloader/secondary may start while one of them is unfinished, a failed xloader/secondary would leave the scheduler waiting forever; the web version skips everything after it instead. A failing BEGIN_IMAGE_UPDATE or FINISH_IMAGE_UPDATE, or an image read error, stops the update at once. When the loop ends with any failed or skipped image, UPDATE_SW_REL is **not** sent and the failure path below runs.
- Failure → `FUN_00410f38` dumps `/update/error_list` (proto ≥ 102), then `FINISH_UPDATE`. This path (`0x411ebe`) is taken only once the image loop has started (a data-loop or BEGIN_IMAGE_UPDATE failure, or failed images at the end). A failure before it (BEGIN_UPDATE, `/update/cmt/verify`, `/update/cmt/perform_rfs`, repartition) returns at once: no error list, no FINISH_UPDATE. A failed BEGIN_ERASE (`0x413c02`) fetches the error list, or for status 11 prints the battery-low message (`FUN_004109df`: "BATTERY IS LOW. DEVICE IS NOW CHARGING.", then "Charging battery, %d %% battery level (10 %% required)"). `SU_CANCEL_UPDATE` is sent only on Ctrl-C (proto ≥ 101), from inside the pending request, after which the same failure path runs.
- Progress UI in the original: `[S] name [state progress% done / total kB  speed kB/s]`; states drawn as `_`,` `,`f`,`-`,`x`,`F` (failed).
- Ordering rules in `FUN_004115b1`: images are looked up for the device's `product_code` + `hw_build` (6.3); a second lookup without device info only decides between `Image %s not present` and `Image %s not present for this HW (%s rev. %s)`. Flag `0x4000` (cert-sw) is OR'd in whenever any of the `0x38F` bits is selected: xloader/secondary (1), kernel (2), initfs (4), rootfs (8), moslo (0x80), mmc (0x100), tar (0x200). `config` is not included. When a rootfs is found, the tar bit is cleared, so tar is skipped (`Image tar skipped`).
- Scheduler (`FUN_00410d29`), table at `0x61fc80` (`{name, u32 mask, u32 group}`): groups are cert-sw 3, cmt-* 1, rootfs/mmc/tar 2, everything else 0. A OneNAND rootfs (no `0x33` layout block) is moved to group 0, an eMMC rootfs stays in group 2. Nothing starts until cert-sw has finished; nothing other than xloader/secondary (mask 1) starts while an xloader/secondary is unfinished; within a group, images run one after another in table order; different groups run in parallel. A sequential client gets the same constraints with the order cert-sw → xloader → secondary → cmt-2nd → cmt-algo → cmt-mcusw → kernel → moslo → rootfs → mmc → tar → config. `initfs` is not in the SU table.

### 5.7 ADL (sync mode) reboot **[bin]**

Used for 0421:03D2 / 0421:051A. Resource `0x6F` (byte 3 overridden), same header otherwise.

1. `msg 0x0D` ADL_SET_BOOT_FLAG, payload `FF FC 00 00 00 00`, reply id `0x2D`.
2. `msg 0x04` ADL_REBOOT_PHONE, payload `24 00`, reply id `0x24`.

Then the device re-enumerates. In `main`, after this reboot the tool re-opens the bus with transport mask 2 (**bootloader/NOLO only**), i.e. the ADL boot flag sends the phone into NOLO flash mode (0421:0105), not into an SU server. The flow then continues as in section 4.

**Real-device observation (N9, `0421:051a` "PC Suite mode")**: composite config with 12 interfaces; interface 1 = class 2/subclass 0xFE (CDC Header 1.10, `05 24 AB 05 15`, Union master 1 → slave 2); interface 2 alt 1 = CDC data, bulk OUT EP2 + bulk IN EP3 (so ISI IN=3, OUT=2, not 1/1). No class-0xFF raw interface in this mode.

### 5.8 Reboot / boot / R&D mode **[bin]**

`DEVICE_STATE_CHANGE (0x0C)` payload is exactly 16 bytes, NUL padded:
- `"reboot"` — plain reboot (`-R`)
- `"reboot=<mode>"` — reboot into a named mode (`-R <mode>` / `-b`)
- `"poweroff"`

`/device/rd_mode` (string):
- set: `+{flag,flag,…}` to add, `-{flag,…}` to remove, `-{*}` to clear all. Flags: `master`(0x1) `no-omap-wd`(0x2) `no-ext-wd`(0x4) `no-lifeguard-reset`(0x8) `serial-console`(0x10) `no-usb-timeout`(0x20) `sti-console`(0x40) `no-charging`(0x80) `force-power-key`(0x100).
- get: reply is a plain comma-separated flag list (no braces), parsed to a bitmask by `FUN_00409a23` (`The device is in %s mode`, `R&D flags %s(0x%04x): %s`). Bit 0 (`master`) is the R&D mode; the other bits are printed with `(not effective) ` when it is clear.
- `--enable-rd-mode` sends `+{master}`. `--disable-rd-mode` sends `-{*}`, which clears **all** flags, not just `master`. `--set-rd-flags=F` only adds `F`, `--clear-rd-flags=F` only removes `F`. Both require a flag list, and `master` is refused (`FUN_004026b3` prints the possible flags and exits with 2), so there is no "clear all flags" without `--disable-rd-mode`.

Over **NOLO**, `FUN_0040d1da(add, del, query)` sends `SET` value=`add` index 3, then `SET` value=`del` index 4 (each only when non-zero), and reads the flag word with `GET` index 3 (u16); the mode is its bit 0 (index 0 is never used). `--enable-rd-mode` = add `0x1`, `--disable-rd-mode` = delete `0xFFFF` (all flags), `--set-rd-flags=F` = add `F`, `--clear-rd-flags=F` = delete `F`. Querying always works; setting works only when the NOLO version is outside 1.5.9 – 1.6.4 (section 4). Otherwise the tool prints "Method is not supported in the current mode. Please, provide the APE flashing algorithm to set the R&D mode/flags." When a FIASCO with ape-algo is given, `main` boots it first and the flags are set over SU.

Messages in the original that the log mirrors: `Server implements softupd protocol version 1.08`, `Found product RM-696 rev. 2102`, `Supported images: …`, `Image SW version …`, `Updating SW release`, `Success`.

---

## 6. FIASCO container **[bin+0xFFFF]**

Big-endian everywhere. Parser = `FUN_0040643f` (file header) + `FUN_0040802a` (sub-images).

### 6.1 File header

```
u8   0xB4                   signature
u32  header_len             bytes that follow (≤ 0x200, must be ≤ file)
u32  block_count            number of {id,len,data} header blocks
repeat block_count:  { u8 id, u8 len, u8 data[len] }
        id 0xE8 = fiasco name (e.g. "OSSO UART+USB")
        id 0x31 = SW release string
```
`FIASCO image header size mismatch` is printed when `header_len+5` exceeds the supplied bound or `0x200`.
The raw block bytes are kept and later sent as the `UPDATE_SW_REL` payload.

### 6.2 Sub-image header

Repeated until EOF, each entry:

```
u8   0x54                  next sub-image
u8   n_sections
n_sections × { u8 id; u8 len; u8 data[len] }       (a "subblock")
u8   checksum              0x00 or  0xFF - (sum of all header bytes after 0x54)   (0xFFFF verifies; the binary only reads it)
u8   data[size]            (size from the file-data subblock)
```

Sections:

| id | name | contents |
|----|------|----------|
| `0x2E` | file data (len `0x19`) | `u8 asic, u8 devtype, u8 devidx, u16 hash, char type[12], u32 size, u32 load_addr` |
| `0x5C` | file data, **64-bit** (len `0x21`) | same but `u64 size` — only tried if no `0x2E` exists |
| `0x31` | version string | NUL included |
| `0x32` | product / HW revisions | `char product[16]`, then 8-byte slots of HW-revision strings (e.g. `RM-696\0…`, `2102`, `2103`, …). Printed as `Valid for RM-696: 2101, 2102, …` |
| `0x33` | layout | rootfs layout string (used only for UBI/eMMC layouts) |
| `0x34` | data part | `u32 ?, u32 offset, u32 ?, u32 size, name…` (rootfs partitions) |
| `0x2F` | partition info | partition table (count, then 6 bytes per partition: type, attr, u32 size) |

`type` examples: `kernel`, `rootfs`, `initfs`, `cmt-2nd`, `cmt-algo`, `cmt-mcusw`, `ape-algo`, `2nd`, `secondary`, `xloader`, `mmc`, `cert-sw`, `tar`, `config`, `moslo`.
`type[0] == 0xFF` marks the end of the list.

Hash: XOR of all little-endian 16-bit words of the data **[0xFFFF `do_hash`]**. The shipping flasher does not recompute it on the Harmattan path **[infer]**.
Alignment: `size` is rounded up to a multiple of 128 (`0x80`) before sending, on every path (SU, NOLO, cold flash). The extra bytes are filled with **`0xFF`** (`fiasco_read_bytes`: `memset(..., 0xff, ...)`), not zero. Plain image files given on the command line are padded the same way.

### 6.3 "Raw subblock blob" sent to the device

`FUN_00405f79` / `FUN_00405e92` re-serialise the parsed subblocks of a sub-image into `{u8 id, u8 len, data}` entries in file order and cap the result at **1024 bytes** (`Subblock list exceeds 1024 in size`). This blob (no `0x54`, no count byte, no checksum) is the payload of:

- NOLO `0x42` / `0x54`,
- SU `BEGIN_IMAGE_UPDATE`.

**Difference from 0xFFFF**: `nolo.c` builds a reduced header (only the matching `0x32` entry, no `0x33`). The real Harmattan flasher sends *every* subblock of the sub-image, unfiltered. Use the real flasher's behaviour.

Per-image matching (`FUN_00406dc7`): images of the requested type are walked **in file order** and the first match wins. An image matches if it has no `0x32` block (generic), or a `0x32` block whose product (`strncmp`, 16 bytes) equals the device's and which either lists no HW revisions (length exactly 16 = any revision) or lists the device's `hw_build` (8-byte slots). With no device info at all (e.g. cold flash), the first image of the type is returned. When the device-specific lookup fails but an image of that type exists, the tool prints `Image %s not present for this HW (%s rev. %s)` and skips it; there is no fallback to a non-matching image.

---

## 7. Open questions (verify on hardware)

0. Cold-flash timing. The original sends the boot message straight after opening the boot ROM device and rescans every 10 ms. The web version scans every 400 ms and waits for the user to click Flash (and confirm). The OMAP ROM waits only a short time for the peripheral boot message before trying the next boot device, so the window may be missed.

1. Exact bytes of `FUN_00414428`/`FUN_00414330` Phonet interface matching for the N9 vs the N950. The structural rules in 2.1 come from the decompile; confirm with `lsusb -v` on both devices in NOLO→ape-algo mode.
2. Aux-pipe use is decided in `FUN_00411344`: image group == 2 (eMMC rootfs, `mmc`), a raw data EP was found (`ctx+0x18 > 0`), and the image is not `tar`. Whether the N9/N950 SU server actually exposes the class-0xFF raw interface still needs a capture.
3. Whether BEGIN_IMAGE_UPDATE accepts blobs from FIASCO images unchanged for `config`/`tar`/`cert-sw`. Not exercised in the strings.
4. Certificate and challenge/response commands (`common_*_cert`, NOLO `0x60-0x62`) are present but not reachable from the CLI of this build. They are out of scope for the web app.
5. Timing: the original sleeps 10 ms between cold-flash writes, 50 ms after boot ROM transfers and 100 ms after NOLO image uploads. Keep these in `protocol.js`.

## 8. Next steps (after you review this file)

- Step 2 layout: `protocol.js` (ISI framing, NOLO control transfers, cold flash, SU client, FIASCO parser as pure functions over a `transport` interface so Node tests can use a fake), `app.js`/`index.html` for UI.
- Unit tests against a synthesized FIASCO and a fake transport that replays the section 5 flow.
- WebUSB caveats (to document in Step 3): `cdc_phonet` binding on the Phonet interface, Chromium auto-detach rules, zero-length packet handling, no `usb_reset`, and 2 MiB transfer limits.
