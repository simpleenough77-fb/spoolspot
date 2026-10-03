# SpoolSpot

An open-source, location-first filament inventory. It answers a few questions with almost no typing:

- Do I have this filament, and where?
- What is loaded where?
- Do I need to order more?
- Where should new spools go?
- Can I print this model with my stock? (later phase)

SpoolSpot tracks **where things are, not how much is left**: no weight, temperatures, cost or per-print usage. Every field is set by a tap or derived from something already known (the clip catalog, a tag). It is designed to work natively with Filament Clip Studio.

> **Status: pre-alpha.** This repository currently holds the development infrastructure, the location schema and the starting location seed. There is nothing to install yet.

## Repository layout

| Path       | Contents                                                                                                                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/`    | Public documentation: [spec](docs/spec.md), [decisions index](docs/decisions/README.md), [development guide](docs/development.md), [accessibility checklist](docs/accessibility-checklist.md) |
| `schema/`  | JSON Schemas for the data contracts                                                                                                                                                           |
| `seed/`    | Starting data, validated against the schemas in CI                                                                                                                                            |
| `app/`     | The application (not started)                                                                                                                                                                 |
| `infra/`   | CI tooling and GitHub settings as code                                                                                                                                                        |
| `scripts/` | Repository checks and developer tools                                                                                                                                                         |

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) first: commits are signed off (DCO), every change carries a ticket key, and every pull request passes the same gates locally and in CI. Report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md). Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

Code is AGPL-3.0-or-later. Data contracts, schemas and seed data are CC0-1.0. Documentation is CC BY 4.0. Each file declares its license (SPDX identifier or [REUSE.toml](REUSE.toml)); the texts are in [LICENSES/](LICENSES/).
