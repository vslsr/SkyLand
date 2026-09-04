# Authoring an `@` entry

Use this reference when writing a new entry into a design note, or when reviewing one before implementing it. The normative field semantics are in [`doc/dsl-designer.md`](../../../../doc/dsl-designer.md); this file is the working checklist.

## Shape

```text
* @<letter> <中文名称>: <one-line summary>
    * <KEY>: <value>
    * <KEY>: <value>
        * <SUBKEY>: <value>
```

- The letter picks the type: `i` item, `b` build piece, `w` tool/weapon, `e` entity (reserved, still being designed).
- Keys are case-sensitive. Fields are unordered but read fastest in the order the definition lists them.
- `0` or an absent line means "none" (`R`, `B`).
- `#design` in a value position is a deliberate blank for the implementer to answer. An absent line is an omission, not a blank. Its parameter says how far to go: `(do)` answer and mark `@todo`, `(w)` answer and implement, `(s,n)` offer n directions and ask. A bare marker means `(do)` — never write code for it.
- `#advice` is the same but starts from existing content: say what would make it better, under the same modes. Concluding "no change needed" is a valid outcome; inventing a suggestion is not.
- `@todo` marks unbuilt content — above a heading for a whole module, or trailing for one line. The design still binds; implement it rather than redesigning it. It does not excuse missing fields.
- Cross-references use the **display name** of another entry, never an id. The referenced entry must actually exist somewhere in the design notes.
- Legacy entries use a full-width `：` on some fields. Read both; write half-width `:`.

## Completeness checklist

### `@i` item

| Key | Must answer | Common mistake |
| --- | --- | --- |
| name + summary | What it is, in one line | Summary longer than 64 chars — `summary` is capped |
| `M` | One model, used for both dropped and held | Describing a separate held model; there is only one |
| `I` | What the icon depicts | Naming an icon that has no sprite yet |
| `F` | Tap or hold, what happens, how much | Writing a verb no system implements; only eat / tool / throw exist |
| `G` | One of 材料 / 补给 / 投掷物 / 弹药 / 价值货物 / 工具 | Inventing a category; the enum is closed |
| `N` | Stack limit | Forgetting that a `slotCost: 0` item does not consume backpack slots |
| `R` | Durability, or `0` | Expecting durability to be consumed — no system does yet |
| `A` | Which states move, which part, driven by what | Naming an action or asset; there is no skeletal animation. The state list is open — reject a state only if it is unclear, not because it is unlisted |

Also decide, though the notation does not ask: the kebab-case `id`, the `tint`, `slotCost`, and whether it is `holdable`.

### `@b` build piece

| Key | Must answer | Common mistake |
| --- | --- | --- |
| name + summary | What the piece does | — |
| `T` | 地基 / 墙壁 / 物件 | A "wall" that is really a fixture; walls occupy a cell **edge**, fixtures a cell-center **slot** |
| `M` | Model | Giving a fixture a foundation/wall model — the catalog rejects it |
| `L` | Which fixtures share a cell | Asking for more than one of the same slot in a cell; `slot` is two-state |
| `I` | Which item enters build mode | **Not implemented.** The build bar comes from the scene's `gameplay.runtimeActorArchetypes` |
| `A` | Placement, removal, and any working animation | Forgetting that a fixture with a function (fire, lid, recoil) needs a `工作`/`交互` state |

Also decide: `surface` (`floating` / `static` / `any`), `reach`, `cost`, and for floating pieces `mass`; for a floating foundation also `buoyancy` and `hull`.

### `@w` tool / weapon

| Key | Must answer | Landing today |
| --- | --- | --- |
| `M` | Model | The associated item's drop archetype |
| `I` | Associated item | An `@i` entry that must exist |
| `B` | Associated build piece, or `0`/absent for a light tool | A `fixture` `@b` for a heavy tool |
| `D.Attack` | Damage, and charge falloff if any | No landing — needs a new system |
| `D.Attack.Tag` | Per-target-tag effect | No landing; `src/tags/` exists, nothing is tagged |
| `D.CD` | Use frequency | No landing; item use has `holdSeconds`, not a cooldown |
| `D.Effect` | On-hit effect | No landing |
| `D.EQS` | How targets are selected | No landing; only `findHarvestablePropNear` exists |
| `A` | Charge (ratio-driven), fire (one-shot), cooldown | Putting the charge arc in `EQS`; the arc is presentation, `EQS` is the hit test |

Writing a `@w` with a populated `D` is a request for new systems. Say that plainly in the implementation plan instead of approximating it with `use.value`, which is harvest strength.

## Review questions

Before implementing an entry, confirm:

1. Does every key the type defines appear, or is its absence deliberate and stated? A `@todo` on the entry does **not** excuse a missing key.
2. Does each cross-reference (`I`, `B`, `cost.itemType`, `L` entries) resolve to something that exists?
3. Does `F` / `D` ask for a verb, category, or piece kind that the closed enums already contain? If not, this change extends the language, not the data.
4. Is the entry a heavy tool? Then it needs **two** entries — an `@i` and a `@b` — not one.
5. Does every `A` state name a part, a pivot, a curve and an amount — and one of `比例` / `一次性` / `持续` / `目标值` as its driver? A ratio-driven entry must say who supplies the ratio.
6. Do the numbers fall inside the schema bounds (`stackLimit` 1–100000, `slotCost` 0–3, `durability` 0–1000, `reach` 1–16, `holdSeconds` 0–10, `cost.quantity` 1–99)?
