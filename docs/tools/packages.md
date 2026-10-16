# Packages

A package is a repository object, `DEVC/K` (ADR-018): read, validated, created, updated and deleted
through the object actions, with its fields as AFF `devc-v1` `properties`
([objects.md](objects.md#properties)). Tools: `adtplus_object` (`read`, `validate`),
`adtplus_object_write` (`create`, `update`), `adtplus_irreversible` (`deleteObject`). A package
lands in its superpackage: that is what the write allowlist decides (ADR-003). Backend and gate
letters: [capabilities.md](../capabilities.md#legend).

| Action | Backend | Gate | Verified |
|---|---|---|---|
| [read](#read) | REST | — | both |
| [validate](#validate) | REST | — | both |
| [create](#create) | REST | A (superpackage) | both |
| [update](#update) | REST | A (superpackage) | both |
| [delete](#delete) (`deleteObject`) | REST | A (superpackage), C | both |

The REST actions are ADR-002 fallbacks; they retire with ADT for VS Code 1.2
([known-issues.md](../known-issues.md#rest-fallbacks)).

## read

- `properties`: `header` (description, original language) and `generalInformation` (type,
  superpackage, application and software component, transport layer, `supportsRecordChanges`,
  `defaultAbapLanguageVersion`, `isAddingObjectsNotAllowed` when set) from the REST package
  document, 1 request. Never the VFS `*.devck.jsonc` (stale).
- `isAddingObjectsNotAllowed`: SAP refuses new objects there ("Cannot add further development
  objects").

## validate

- A dry run of create (same parameters); returns the full definition create would send and SAP's
  verdict. Other types are refused so far.

## create

- `name`, `package` (the superpackage), `description`, `transport` when the package records
  changes; `properties.generalInformation` may set `softwareComponent`, `transportLayer`,
  `applicationComponent`, `supportsRecordChanges` and `defaultAbapLanguageVersion` (which must be
  the system's). Defaults: software component from the superpackage (SAP can refuse another one,
  TR458), else the system's `defaultSoftwareComponent`; layer and change recording from the
  superpackage. A development package only.
- Language version from policy, re-read after create. The responsible user is the logged-on user
  (ADT's system information, read once per session; else the system's `user`), as ADT's wizard
  proposes; AFF has no field for it.

## update

- `header.description` and `generalInformation.applicationComponent`; any other key is refused
  (SE21 for the rest). `transport` defaults to the request already locking the package.
- "Adding further objects not possible" is sent back when set: the PUT replaces the whole package,
  and one without the attribute clears the flag ([below](#known-issues)).

## delete

- `adtplus_irreversible deleteObject` with `DEVC/K`. SAP refuses a non-empty package.

## Known issues

- **`pak:isAddingObjectsAllowed` means the opposite of its name** (`onprem` and `cloud-erp`, 2026-10-10):
  `"true"` on a package with "Adding
  further objects not possible" checked, whose creates fail with "Cannot add further development
  objects to package …"; `"false"` where creates work. A PUT with `"true"` sets the flag and
  `"false"` clears it. adt+ reads it as `addingObjectsNotPossible` and sends SAP's value back
  unchanged; don't "fix" the inversion. The package PUT is a full replace: **a PUT without the
  attribute clears the flag** (`onprem`), so an update always sends it when set.
- **A package can't be deleted while deletions of its objects sit in an unreleased request**
  ("Paket … enthält noch Entwicklungsobjekte oder andere Pakete", `onprem`, M3 cleanup): release the
  request that recorded the deletions first, then delete the package on another request.
- **A `cloud-erp` package that held a service binding can't be deleted** ("still contains development
  objects or other packages", M4 cleanup). Deleting the SRVB leaves its generated SUSH in the
  object directory with the deletion flag set (`I_CustABAPObjDirectoryEntry`,
  `ABAPObjectIsDeleted = 'X'`); in a local `ZLOCAL` package no transport release ever clears it,
  and the package check counts it. ADT, Eclipse and ARC-1 list the package as empty. Eleven such
  entries on `cloud-erp` (seven in `ZADTPLUS_TEST`). For live tests with a binding on `cloud-erp`, reuse one
  throwaway package instead of creating a new one per run.
