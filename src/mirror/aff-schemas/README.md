# Vendored AFF schemas

JSON schemas (draft 2020-12) from [SAP/abap-file-formats](https://github.com/SAP/abap-file-formats),
commit `a7a63b5794ee459d740e58fc62f5c55db96ba3a9` (2026-09-29), files
`file-formats/<type>/<type>-v<n>.json`, unchanged. MIT License, see `LICENSE`
(the repo's `LICENSES/MIT.txt`).

Only the types adt-ls serves as editable `.json` files (probe 3's creatable types plus the types
seen in pulls): `bdef chdo clas dcls ddls ddlx desd dras drty dteb enqu fugr func intf nont nrob
prog reps ront srvb srvd tabl tabt type`, `msag`, which the mirror writes itself over REST
(ADR-014), `devc`, the shape of a package's `properties` (ADR-018), and `doma`, `dtel`, the shape
of a domain's and a data element's `properties` (REST fallbacks, 2026-10-14). `mirror check` counts a `.json` of any other type as
"no schema". To add or refresh one, fetch it from the same path at a newer commit, add it to
`index.ts`, and update the commit above.
