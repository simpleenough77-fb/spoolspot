# SpoolSpot spec (public snapshot)

Snapshot of the product spec for contributors. The project's documentation space is canonical; this copy can lag.

## Purpose

A lean, location-first inventory for filament, built to work natively with Filament Clip Studio. The tool serves the user: nothing gets typed that a tap or the clip catalog can supply.

## Principles

- Track where things are, not how much is left. No weight, temperature, cost or usage tracking.
- Every field is set by a tap or derived from something already known. A field that needs typing does not ship.
- Open data: plain JSON/CSV export and a documented tag format.

## Location model

Four location types:

| Type            | Holds                                                  | Capacity mode (default) |
| --------------- | ------------------------------------------------------ | ----------------------- |
| passive_storage | boxed and bagged spools, counts only                   | soft                    |
| active_storage  | opened, labeled (clipped) spools not in use            | hard                    |
| active_use      | the spool loaded in an AMS slot, dryer slot or similar | hard (1 per slot)       |
| clip_storage    | clips with no spool; any number of locations           | soft                    |

- Every leaf location has a maximum number of units. Hard: never suggested over it, and a manual placement over it warns. Soft: can be exceeded with a notice.
- Capacity can be left unset; the location is then left out of space suggestions until it has one.
- Every item counts as one unit, including a spoolless refill pack.
- Clip storage may carry an optional manufacturer preference, used as a hint for suggestions and never enforced.
- Printers, AMS units, dryers and similar are containers; only their slots are leaves.
- NFC pockets on the printed clip holders map one-to-one to active_use slots. Shelves, drawers and clip bins get sticker tags. Every tag flow has a non-NFC equivalent.

The starting tree is in [`seed/locations-seed.json`](../seed/locations-seed.json), validated against [`schema/locations-seed.schema.json`](../schema/locations-seed.schema.json): 81 locations (30 slots, 9 active shelves with 107 places, 14 passive shelves and drawers, 1 clip bin).

## What gets tracked

```yaml
filament: { manufacturer, type, color, spool_kind: refillable|disposable } # from the clip catalog
stock: { filament, location, pack: spool|refill, count } # boxed/bagged, counts only
clip: { tag, filament, location, state: on_spool|spool_empty|free } # free = in clip storage
```

A clip's text is fixed, so a clip belongs to one filament for life. `refill` is only valid for refillable filaments.

## Workflows

1. **New spool, first use.** Pick the filament; the count drops by one. Reuse a free clip for that filament or print a new one. Tap the destination to place it.
2. **Retire a spool.** Tap the clip, choose retire, tap a clip bin. The clip goes to clip storage.
3. **Refill.** Tap the clip on a spent spool and choose a refill stock line. The count drops by one and the clip returns to on_spool.
4. **Intake.** Enter filament, quantity and pack type. Suggested locations: where the same filament already is, then the manufacturer preference, then the most free capacity, splitting if one is full.

## Questions the system answers

Do I have X and where; what is loaded where; do I need to order X; where should new spools go; can I print this model with my stock (later phase).

## Not tracking

Weight or remaining filament, temperatures, cost, usage per print.
