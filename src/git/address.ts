/**
 * The address in `adtplus::<address>` (docs/decisions/011-git-remote-helper.md):
 * `<system>/package/<PKG>`, optionally `?no-subpackages`, or `<system>/swc/<SWC>`,
 * a software component's root packages with their subpackages (G4). A namespaced
 * package keeps its slashes: `onprem/package//NSPC/PKG`.
 */
export interface GitAddress {
  system: string;
  kind: 'package' | 'swc';
  /** The package, or the software component. */
  name: string;
  subpackages: boolean;
}

const USAGE = 'adtplus::<system>/package/<PKG>[?no-subpackages] or adtplus::<system>/swc/<SWC>';

/** `package ZADTPLUS_A`, `swc ZT1_DEV`: the address's object in messages. */
export function addressLabel(address: GitAddress): string {
  return `${address.kind} ${address.name}`;
}

/** The address as the URL names it, without `adtplus::`. */
export function formatAddress(address: GitAddress): string {
  return `${address.system}/${address.kind}/${address.name}${address.subpackages ? '' : '?no-subpackages'}`;
}

export function parseAddress(address: string): GitAddress {
  const [location = '', query, ...more] = address.split('?');
  if (more.length > 0) throw new Error(`"${address}" is no adt+ git address; use ${USAGE}`);
  const slash = location.indexOf('/');
  const system = slash > 0 ? location.slice(0, slash) : '';
  const rest = location.slice(slash + 1);
  if (system === '' || slash < 0) throw new Error(`"${address}" names no system; use ${USAGE}`);
  const kind = rest.startsWith('package/') ? 'package' : rest.startsWith('swc/') ? 'swc' : undefined;
  if (kind === undefined || rest.length === `${kind}/`.length) {
    throw new Error(`"${address}" names no package or software component; use ${USAGE}`);
  }
  const options = query === undefined || query === '' ? [] : query.split('&');
  for (const o of options) {
    if (o !== 'no-subpackages') throw new Error(`unknown option "${o}" in "${address}"; the one option is ?no-subpackages`);
    // A component's root packages are only its own with their subpackages.
    if (kind === 'swc') throw new Error(`?no-subpackages is for package addresses; a software component takes its packages whole`);
  }
  return { system, kind, name: rest.slice(kind.length + 1).toUpperCase(), subpackages: !options.includes('no-subpackages') };
}

/**
 * The remote name git passes: names the private refs and the shadow folder. An
 * anonymous URL (`git fetch adtplus::…`) arrives as the URL itself and is refused.
 */
export function checkRemoteName(remote: string): string {
  const segments = remote.split('/');
  if (remote.includes('::') || !segments.every((s) => /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(s) && !s.endsWith('.lock'))) {
    throw new Error(`fetch through a named remote (git remote add <name> ${remote.includes('::') ? remote : 'adtplus::…'}), not "${remote}"`);
  }
  return remote;
}
