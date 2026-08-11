# presence ต้องรู้ pane ของตัวเองเสมอ ไม่งั้นปฏิเสธ (kobo-868)

> Card B ของ kobo-856 · Tony เคาะ "มันบัค" 2026-08-09 · ออกแบบ eq3 (kobo-868#c1) · ทำ patchwork

## 1. บั๊ก

**ผู้เขียน** `src/commands/plugins/presence/index.ts` (ก่อนแก้)
```ts
const paneId = process.env.TMUX_PANE || undefined;
...
appendWorklog({ ..., ...(paneId ? { paneId } : {}), kind: sub === "away" ? "away" : "back", ... });
```
ไม่มี `TMUX_PANE` ก็ยังเขียน event ต่อไปเงียบๆ แค่ไม่มี `paneId` แนบมา

**ผู้อ่าน** `src/core/worklog/presence-away.ts` (`isPaneAway`, **ไม่แก้ในใบนี้**)
```ts
if (pid && e.paneId && e.paneId !== pid) continue;   // marker ไร้ paneId ไม่ถูกข้าม
if (e.kind === "away") return true;
if (e.kind === "back") return false;
```
marker ไร้ `paneId` ตัดสินให้ **ทุก pane** ของ oracle นั้น — นี่คือ "the oracle-level fallback" ที่ตั้งใจไว้ตั้งแต่ kobo-120/287 (ดูคอมเมนต์ในไฟล์ บรรทัด 92-95) — **ไม่ใช่บั๊ก**

**บั๊กคือ asymmetry ระหว่างผู้เขียน 2 คำสั่ง:** `away` เขียนได้แบบไร้ paneId (ครอบทุก pane) แต่ `back` มี paneId เสมอ (มาจากพร็อกเซสจริงที่รันอยู่ใน pane จริง — ไม่มีทางที่ `back` จะครอบทุก pane ได้)
⇒ **away ไร้ paneId 1 ใบ = ทุก pane ของ oracle นั้น away ถาวร ไม่มี `back` ปกติใบไหนล้างได้เลย**

**หลักฐานจริง** (สืบใน kobo-856): 3 ใบ away-ไร้-paneId ทั้งเครื่อง ทั้งหมดเป็น `eq3`, ลงเวลา `2026-08-03T23:03Z`. 2 ใบ `back` ที่ตามมาถือ `paneId=%373` เท่านั้น จึงล้างได้แค่ pane เดียว ส่วนที่เหลือยังติด ALL-PANES ถาวร ผลคือ **ส่ง `maw hey` ไปหา eq3 ได้ `message NOT delivered` ทุกครั้งตั้งแต่วันนั้น**

## 2. กฎที่ใช้ตัดสิน

> **ไม่รู้ว่าตัวเองเป็น pane ไหน = ไม่มีสิทธิ์เขียน presence**

## 3. สิ่งที่เปลี่ยน — semantics change ที่ WRITER เท่านั้น

**ไม่แตะ `isPaneAway`/`presence-away.ts`** — oracle-level fallback ยังทำงานเหมือนเดิมทุกกรณี รวมถึงกับ marker ไร้ paneId ที่ (ในอนาคต) เขียนโดยเจตนา ถ้ามี — **ที่เปลี่ยนคือใครมีสิทธิ์เขียน marker แบบนั้นได้เลย** ไม่ใช่วิธีอ่านมัน

### 3.1 `TMUX_PANE` มีค่า → เหมือนเดิมทุกประการ
Event มี `paneId` เหมือนเดิม ทางปกติ (operator นั่งอยู่ใน tmux pane จริง) ไม่พัง — นี่คือ negative control (AC3).

### 3.2 `TMUX_PANE` ไม่มีค่า → **ปฏิเสธ ไม่เขียนอะไรเลย**
กฎเดียวกันทั้ง `away` และ `back` — ถ้าให้กฎต่างกัน (เช่น away เขียนได้แต่ back ไม่ได้) จะเปิดช่องให้ติดป้ายได้แต่ปลดไม่ได้ (หรือกลับกัน) ซึ่งเป็นรูปบั๊กเดิมในคราบใหม่

**สิ่งที่ operator เห็น:**
- `maw presence away` (ไม่มี `TMUX_PANE`) → บรรทัดสีแดง `✗ presence away refused` พิมพ์ทันที + ชี้ไปที่ doc นี้
- exit code **≠ 0** (ผ่าน `{ ok: false, error }` ที่ `src/cli/dispatch.ts` แปลงเป็น `process.exit(result.exitCode ?? 1)`)
- **แถวใน worklog ก่อน/หลังเท่ากันเป๊ะ** — ไม่มีการเขียนอะไรเลย ไม่ใช่แค่ไม่มี `paneId`
- ข้อความ error เต็ม (ผ่าน stderr): บอกทั้งเหตุ (`TMUX_PANE is not set, so this process cannot prove which pane it is`) และทางแก้ (`run 'maw presence <sub>' from inside the tmux pane it applies to`)

**ห้าม fallback ไปถาม tmux เอง** (ตามที่ระบุใน forbidden) — `core/pane-identity.ts:56-58` เตือนไว้ชัดว่า target ว่างจะ resolve เป็น active pane ของ**ผู้เรียก**เงียบๆ ไม่ใช่ "ไม่มี pane" ⇒ ถ้า process รันอยู่นอก pane ที่ active (เช่น cron/hook/background) จะได้ pane **ผิดตัว** แล้วไปติดป้าย away ให้ pane บริสุทธิ์ ในขณะที่ pane ที่ operator ออกไปจริงยังเปิดรับ hey อยู่ — แย่กว่าการปฏิเสธเฉยๆ โค้ดที่แก้ไว้จึงไม่เรียก tmux เพื่อเดา pane ตัวเองเลย (ยืนยันแล้ว: `presence/index.ts` เรียก `execFileSync("tmux", ...)` แค่จุดเดียวใน `resolveOracle()` เพื่อหา**ชื่อ session** ตอน `CLAUDE_AGENT_NAME` ไม่ตั้ง — นั่นคือการหาชื่อ oracle ไม่ใช่การเดา pane ของตัวเอง และยังทำงานได้เมื่อไม่มี `TMUX_PANE` เพราะเป็นคนละคำถาม — AC7).

### 3.3 มองเห็นได้ — คอลัมน์ `AWAY` ใน `maw ls -v`

เพิ่มคอลัมน์ `AWAY` ในโหมด verbose ของ `maw ls` (`-v`/`--verbose`, `src/commands/plugins/tmux/impl.ts`) ต่อ pane:
- ไม่ away → คอลัมน์ว่าง
- away → `AWAY <marker> <เวลา>` สีแดง — `<marker>` คือ `paneId` ของ marker ที่ตัดสิน หรือ `ALL-PANES` ถ้า marker นั้นไร้ `paneId` (นี่คือรูปที่ poison เป็น — เห็นได้ตรงๆ ไม่ต้องเดา)
- oracle ที่ไม่มี away/back marker เลย → away=false, ไม่มีอะไรให้โชว์ (เทียบเท่า "ผู้ตัดสิน=none")

Helper ที่ทำหน้าที่นี้ (`paneAwayJudge` ใน `tmux/impl.ts`) เป็น **twin แบบอ่านอย่างเดียวของ `isPaneAway`** — ลอกลูป newest-wins เดียวกันเป๊ะแต่คืนค่า marker ที่ตัดสินด้วย ไม่ได้ export เพิ่มจาก `presence-away.ts` เพราะไฟล์นั้นอยู่นอกขอบเขตใบนี้ (forbidden) — จึงแยกเป็นตัวอ่านสำหรับ display ต่างหาก ไม่ผูกกับ read-path ที่ comm-send ใช้จริง (การเปลี่ยน twin นี้ในอนาคตจะไม่กระทบ delivery gate).

`paneAwayJudge` เองไม่มี IO (pure, เทสได้ตรงๆ) — ตัว IO wrapper (`paneAwayJudgeForRow`) โหลด `core/worklog/store`/`presence-away` ด้วย **dynamic `import()`** แทน static import ที่หัวไฟล์ เพราะ `tmux/impl.ts` ถูก ~15 ไฟล์ isolated-coverage-test mock `"fs"` แบบแคบ (แค่ `existsSync`/`readdirSync`/`readFileSync`) — static import จะดึง `appendFileSync`/`mkdirSync` เข้ามาตอนโหลดโมดูล พังทุกไฟล์ที่ mock แบบนี้ทันทีไม่ว่าจะเรียก AWAY column จริงหรือไม่ (เจอจริงตอน CI: `tmux-impl-extra-coverage.test.ts` และ `tmux-impl-plugin-second-pass-coverage.test.ts` พังด้วย `SyntaxError: Export named 'appendFileSync' not found` ก่อนแก้เป็น dynamic import + wrap try/catch fail-soft).

ใช้ `ls -v` ที่มีอยู่แล้ว (ไม่มีคำสั่ง/flag ใหม่) ตามที่ forbidden ระบุ.

## 4. out of scope (ตามใบ)

- `isPaneAway`/`presence-away.ts` — ไม่แตะ (kobo-120/287 design)
- ไม่มี flag `--all-panes`
- ไม่ลบ/แก้ event เก่าใน worklog (Nothing is Deleted)
- `comm-send.ts`, `MAW_HEY_INBOX_AUTOWRITE`, inbox writer — ไม่แตะ
- auto-expire ของ away — ไม่ทำ (sticky โดยเจตนา, kobo-287)
- ไฟล์ skill `/toilet`/`/seat` — คนละ repo ไม่แตะ

## 5. ชะตากรรมของ 3 poison markers ที่มีอยู่แล้ว

**Fix นี้ไม่ลบ/แก้ event เก่า และไม่ auto-neutralize อะไร** — Nothing is Deleted + ไม่แตะ read-side แปลว่า 3 marker `ALL-PANES` วันที่ 2026-08-03 ยัง **ตัดสิน "away" อยู่จนกว่าจะมี `back` ที่ตัดสินทีหลังมันในลำดับเวลา** (newest-wins) การกู้จึงต้องเป็น**ขั้นตอนที่มือมนุษย์/eq3 ทำเอง** ไม่ใช่โค้ดในใบนี้:

**คำสั่งที่ต้องรัน (โดย eq3 เอง จากแต่ละ pane ที่ยังมีชีวิตอยู่จริง):**
```
maw presence back
```
รันจาก**ทุก pane ของ eq3 ที่ยังเปิดอยู่** (แต่ละ pane มี `TMUX_PANE` ของตัวเอง หลัง fix นี้คำสั่งจะปฏิเสธถ้ารันนอก tmux pane จริง — ซึ่งคือพฤติกรรมที่ถูกต้อง) แต่ละ `back` จะเขียน event ใหม่ที่มี `paneId` ของ pane นั้นจริงๆ และเพราะ newest-wins, `back` ใหม่กว่าจะตัดสินให้ pane นั้น**เฉพาะ** — ไม่ใช่ล้าง ALL-PANES marker เดิม (มันยังอยู่ใน log ตลอดไป) แค่ไม่ใช่ marker ล่าสุดของ pane นั้นอีกต่อไป

**patchwork ไม่รันคำสั่งนี้เอง** — ทีมงานสั่งห้ามชัดเจน ("never clear or set anyone's real presence state") การกู้จึงเป็น**ขั้นตอนที่ 2** ตามลำดับที่ระบุใน spec (ดู kobo-868#c1 หัวข้อ 6): (1) ship 3.1-3.3 [ใบนี้] → (2) eq3 รัน `maw presence back` จากทุก pane ที่ยังอยู่ + แนบ `maw ls -v` ก่อน/หลัง → (3) ยืนยัน AC6 ด้วยการส่ง hey จริง

**ยืนยันแล้ว (read-only, ก่อนกู้)** — รัน `maw ls -v` จากซอร์สของใบนี้กับ worklog จริงในสภาพปัจจุบัน (ไม่ได้แก้ไขข้อมูล):
```
◐ 05-eq3:eq3-oracle.0     AWAY ALL-PANES 2026-08-03   fleet: eq3
◌ 05-eq3:cell-workers.0   AWAY ALL-PANES 2026-08-03   fleet: eq3
◌ 05-eq3:cell-workers.1   AWAY ALL-PANES 2026-08-03   fleet: eq3
```
ตรงกับ AC5 เป๊ะ — คอลัมน์ AWAY ชี้ตัวการได้ทันทีโดยไม่ต้องเดา

## 6. AC — สถานะ

1. ✅ ไม่มี `TMUX_PANE` รัน `away` → exit ≠ 0, แถว worklog ก่อน/หลังเท่ากัน — เทสใน `test/presence-away.test.ts`
2. ✅ เหมือนข้อ 1 กับ `back`
3. ✅ มี `TMUX_PANE` → เขียนปกติ มี `paneId` (negative control) — เทสใน `test/presence-away.test.ts`
4. ✅ `ls -v` โชว์ away ต่อ pane + ผู้ตัดสิน; ไม่มี marker → away=false — เทสของ `paneAwayJudge` ใน `test/isolated/tmux-ls.test.ts`
5. ✅ รันบนสถานะจริงของ eq3 ก่อนกู้ — เห็นผลตรงหัวข้อ 5 ด้านบน
6. ⏳ **รอ eq3** — repro ปลายทาง (hey landed) เกิดขึ้นได้หลังขั้นตอน (2) ในหัวข้อ 5 เท่านั้น ไม่ใช่สิ่งที่ patchwork ทำเองได้ในใบนี้
7. ✅ ไม่มี code path เรียก tmux เพื่อเดา pane ของตัวเองใน `presence/index.ts` — เรียก tmux แค่จุดเดียว (`resolveOracle()`) เพื่อหาชื่อ**session**สำหรับตั้งชื่อ oracle เมื่อไม่มี `CLAUDE_AGENT_NAME`, ไม่ใช่การเดา pane ของตัวเอง และยังทำงานได้แม้ไม่มี `TMUX_PANE`

## 7. ไฟล์ที่แตะ

- `src/commands/plugins/presence/index.ts` — guard (3.1/3.2)
- `src/commands/plugins/tmux/impl.ts` — คอลัมน์ AWAY + `paneAwayJudge` (3.3)
- `test/presence-away.test.ts` — เทสเพิ่มใน describe บล็อกใหม่ (ไม่ใช่ไฟล์ใหม่)
- `test/isolated/tmux-ls.test.ts` — เทสเพิ่มใน describe บล็อกใหม่ (ไม่ใช่ไฟล์ใหม่)
- `docs/presence-pane-identity.md` — เอกสารนี้

**plugin-coverage-gate**: ไม่เข้าเงื่อนไข — gate เช็คเฉพาะไฟล์ใต้ `src/vendor/mpr-plugins/` หรือ `src/vendor-plugins/` (`scripts/check-plugin-coverage-gate.ts:74`) ทั้ง `presence` (`src/commands/plugins/presence/`) และ `tmux` (`src/commands/plugins/tmux/`) ไม่ได้อยู่ใต้ vendor path — ยืนยันโดยอ่าน regex ของ gate โดยตรง ไม่ต้องเพิ่ม `test/isolated/plugin-presence-standalone.test.ts`
