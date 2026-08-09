import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const installer = join(repositoryRoot, 'scripts/install-docker-ubuntu.sh');
const dockerPackages = [
  'docker-ce',
  'docker-ce-cli',
  'containerd.io',
  'docker-buildx-plugin',
  'docker-compose-plugin',
];

const harnessSource = String.raw`#!/usr/bin/env bash
set -Eeuo pipefail

source "$INSTALLER_PATH"

log_command() {
  printf '%q ' "$@" >> "$FAKE_COMMAND_LOG"
  printf '\n' >> "$FAKE_COMMAND_LOG"
}

has_package() {
  [[ " $FAKE_INSTALLED_PACKAGES " == *" $1 "* ]]
}

add_package() {
  has_package "$1" || FAKE_INSTALLED_PACKAGES="${'$'}{FAKE_INSTALLED_PACKAGES:+$FAKE_INSTALLED_PACKAGES }$1"
}

create_package_payload() {
  local package="$1" path=''
  case "$package" in
    docker-ce) path="$FAKE_DOCKER_UNIT_PATH" ;;
    docker-ce-cli) path="$PACKAGED_DOCKER_CLI_PATH" ;;
    containerd.io) path="$FAKE_CONTAINERD_UNIT_PATH" ;;
    docker-compose-plugin) path="$PACKAGED_COMPOSE_PLUGIN_PATH" ;;
    *) return ;;
  esac
  command mkdir -p -- "${'$'}{path%/*}"
  if [[ "$package" == docker-ce || "$package" == containerd.io ]]; then
    printf '[Service]\nExecStart=/usr/bin/true\n' > "$path"
    command chmod 0644 -- "$path"
  else
    printf '#!/bin/sh\nexit 0\n' > "$path"
    command chmod 0755 -- "$path"
  fi
}

maybe_fail() {
  local command
  printf -v command '%s ' "$@"
  if [[ -n "${'$'}{FAKE_FAIL_MATCH:-}" && "$command" == *"$FAKE_FAIL_MATCH"* ]]; then
    printf 'injected failure: %s\n' "$FAKE_FAIL_MATCH" >&2
    return 41
  fi
}

run_uname() { log_command uname "$@"; printf '%s\n' "${'$'}{FAKE_UNAME:-Linux}"; }
run_id() {
  log_command id "$@"
  if [[ "${'$'}{1-}" == -u ]]; then
    printf '%s\n' "${'$'}{FAKE_UID:-0}"
  elif [[ "${'$'}{1-}" == -nG ]]; then
    printf '%s\n' "${'$'}{FAKE_USER_GROUPS:-users}"
  fi
}
run_dpkg() {
  log_command dpkg "$@"
  if [[ "${'$'}{1-}" == --print-architecture ]]; then
    printf '%s\n' "${'$'}{FAKE_ARCH:-amd64}"
  elif [[ "${'$'}{1-}" == --verify && "${'$'}{2-}" == "${'$'}{FAKE_TAMPERED_PACKAGE:-}" ]]; then
    printf '??5??????  %s /usr/bin/docker\n' "$2"
    return 1
  fi
}
run_dpkg_query() {
  log_command dpkg-query "$@"
  if [[ "${'$'}{1-}" == -S ]]; then
    if [[ "${'$'}{2-}" == "$FAKE_DOCKER_UNIT_PATH" ]]; then
      printf '%s: %s\n' "${'$'}{FAKE_DOCKER_UNIT_OWNER:-docker-ce}" "${'$'}{2-}"
    elif [[ "${'$'}{2-}" == "$FAKE_CONTAINERD_UNIT_PATH" ]]; then
      printf '%s: %s\n' "${'$'}{FAKE_CONTAINERD_UNIT_OWNER:-containerd.io}" "${'$'}{2-}"
    elif [[ "${'$'}{2-}" == "$PACKAGED_COMPOSE_PLUGIN_PATH" ]]; then
      printf '%s: %s\n' "${'$'}{FAKE_COMPOSE_OWNER:-docker-compose-plugin}" "${'$'}{2-}"
    else
      printf '%s: %s\n' "${'$'}{FAKE_CLI_OWNER:-docker-ce-cli}" "${'$'}{2-}"
    fi
    return
  fi
  local package="${'$'}{*: -1}"
  if has_package "$package"; then
    if [[ "${'$'}{2-}" == '-f=${'$'}{Version}' ]]; then
      printf '%s\n' "${'$'}{FAKE_INSTALLED_VERSION:-5:27.0.0}"
    else
      printf 'installed\n'
    fi
  fi
}
run_apt_get() {
  log_command apt-get "$@"
  maybe_fail apt-get "$@" || return $?
  local argument install_mode=false
  for argument in "$@"; do
    [[ "$argument" == install ]] && install_mode=true
  done
  if [[ "$install_mode" == true ]]; then
    for argument in "$@"; do
      if [[ "$argument" != -* && "$argument" != install ]]; then
        add_package "$argument"
        create_package_payload "$argument"
      fi
    done
  fi
}
run_apt_cache() {
  log_command apt-cache "$@"
  maybe_fail apt-cache "$@" || return $?
  local package="${'$'}{*: -1}" candidate_mode="${'$'}{FAKE_CANDIDATE:-official}"
  if [[ -n "${'$'}{FAKE_BAD_CANDIDATE_PACKAGE:-}" && "$package" == "${'$'}{FAKE_BAD_CANDIDATE_PACKAGE}" ]]; then
    candidate_mode="${'$'}{FAKE_BAD_CANDIDATE_MODE:-foreign}"
  fi
  if [[ -n "${'$'}{FAKE_BAD_INSTALLED_ORIGIN_PACKAGE:-}" && "$package" == "$FAKE_BAD_INSTALLED_ORIGIN_PACKAGE" ]]; then
    printf '  Installed: 5:27.0.0\n  Candidate: 6:28.0.0\n  Version table:\n     6:28.0.0 500\n        500 https://download.docker.com/linux/ubuntu stable\n *** 5:27.0.0 100\n'
    if [[ "${'$'}{FAKE_BAD_INSTALLED_ORIGIN_MODE:-foreign}" == mixed ]]; then
      printf '        500 https://download.docker.com/linux/ubuntu stable\n'
    fi
    if [[ "${'$'}{FAKE_BAD_INSTALLED_ORIGIN_MODE:-foreign}" != missing ]]; then
      printf '        500 https://packages.example.invalid stable\n'
    fi
    printf '        100 /var/lib/dpkg/status\n'
  elif [[ "$candidate_mode" == none ]]; then
    printf '  Candidate: (none)\n'
  elif [[ "$candidate_mode" == foreign ]]; then
    printf '  Candidate: 1.0\n  Version table:\n     1.0 500\n        500 https://packages.example.invalid stable\n'
  elif [[ "$candidate_mode" == mixed ]]; then
    printf '  Candidate: 1.0\n  Version table:\n     1.0 500\n        500 https://download.docker.com/linux/ubuntu stable\n        500 https://packages.example.invalid stable\n'
  else
    printf '  Installed: 5:27.0.0\n  Candidate: 5:27.0.0\n  Version table:\n *** 5:27.0.0 500\n        500 https://download.docker.com/linux/ubuntu stable\n        100 /var/lib/dpkg/status\n'
  fi
}
run_curl() {
  log_command curl "$@"
  maybe_fail curl "$@" || return $?
  local previous='' argument output=''
  for argument in "$@"; do
    [[ "$previous" == --output ]] && output="$argument"
    previous="$argument"
  done
  printf '%s\n' '-----BEGIN PGP PUBLIC KEY BLOCK-----' 'fixture' '-----END PGP PUBLIC KEY BLOCK-----' > "$output"
}
run_gpg() {
  log_command gpg "$@"
  maybe_fail gpg "$@" || return $?
  printf 'pub:-:4096:1:FIXTURE:0:0::::::scESC::::::23::0:\n'
  printf 'fpr:::::::::%s:\n' "${'$'}{FAKE_GPG_FINGERPRINT:-9DC858229FC7DD38854AE2D88D81803C0EBFCD88}"
  printf 'sub:-:4096:1:FIXTURESUB:0:0::::::e::::::23:\n'
  printf 'fpr:::::::::2222222222222222222222222222222222222222:\n'
  if [[ "${'$'}{FAKE_GPG_EXTRA_PRIMARY:-0}" == 1 ]]; then
    printf 'pub:-:4096:1:EXTRA:0:0::::::scESC::::::23::0:\n'
    printf 'fpr:::::::::1111111111111111111111111111111111111111:\n'
  fi
}
run_stat() {
  log_command stat "$@"
  local path="${'$'}{*: -1}" owner=0 mode=644
  [[ ! -d "$path" ]] || mode=755
  [[ "$path" != "$PACKAGED_DOCKER_CLI_PATH" && "$path" != "$PACKAGED_COMPOSE_PLUGIN_PATH" ]] || mode=755
  if [[ -n "${'$'}{FAKE_UNSAFE_STAT_PATH:-}" && "$path" == "$FAKE_UNSAFE_STAT_PATH" ]]; then
    owner="${'$'}{FAKE_STAT_OWNER:-$owner}"
    mode="${'$'}{FAKE_STAT_MODE:-$mode}"
  fi
  printf '%s %s\n' "$owner" "$mode"
}
run_systemctl() {
  log_command systemctl "$@"
  maybe_fail systemctl "$@" || return $?
  [[ "${'$'}{FAKE_SYSTEMD:-healthy}" != unavailable ]] || return 1
  if [[ "$1" == show ]]; then
    local argument property='' service=''
    for argument in "$@"; do
      [[ "$argument" != --property=* ]] || property="${'$'}{argument#--property=}"
      [[ "$argument" != *.service ]] || service="$argument"
    done
    case "$property:$service" in
      Version:) printf '255\n' ;;
      FragmentPath:docker.service)
        if [[ "${'$'}{FAKE_DOCKER_FRAGMENT_OVERRIDE:-__default__}" == __default__ ]]; then
          if has_package docker-ce; then printf '%s\n' "$FAKE_DOCKER_UNIT_PATH"; fi
        else
          printf '%s\n' "$FAKE_DOCKER_FRAGMENT_OVERRIDE"
        fi
        ;;
      FragmentPath:containerd.service)
        if [[ "${'$'}{FAKE_CONTAINERD_FRAGMENT_OVERRIDE:-__default__}" == __default__ ]]; then
          if has_package containerd.io; then printf '%s\n' "$FAKE_CONTAINERD_UNIT_PATH"; fi
        else
          printf '%s\n' "$FAKE_CONTAINERD_FRAGMENT_OVERRIDE"
        fi
        ;;
      DropInPaths:docker.service) printf '%s\n' "${'$'}{FAKE_DOCKER_DROP_INS:-}" ;;
      DropInPaths:containerd.service) printf '%s\n' "${'$'}{FAKE_CONTAINERD_DROP_INS:-}" ;;
    esac
    return
  fi
  [[ "${'$'}{FAKE_SERVICE_FAILURE:-}" != "$1" ]] || return 1
}
run_local_docker() {
  log_command docker "$@"
  maybe_fail docker "$@" || return $?
  local command
  printf -v command '%s ' "$@"
  command="${'$'}{command% }"
  [[ "${'$'}{FAKE_DOCKER_FAILURE:-}" != "$command" ]] || return 1
}
run_local_compose() {
  log_command docker-compose "$@"
  maybe_fail docker-compose "$@" || return $?
  local command
  printf -v command '%s ' "$@"
  command="${'$'}{command% }"
  [[ "${'$'}{FAKE_COMPOSE_FAILURE:-}" != "$command" ]] || return 1
}
run_getent() {
  log_command getent "$@"
  if [[ "${'$'}{1-}" == -s ]]; then shift 2; fi
  if [[ "$1" == passwd ]]; then
    [[ "${'$'}{FAKE_USER_EXISTS:-1}" == 1 ]] || return 2
    printf '%s:x:%s:1000:Fixture User:/home/%s:/bin/bash\n' "$2" "${'$'}{FAKE_USER_UID:-1000}" "$2"
  elif [[ "$1" == group && "${'$'}{FAKE_DOCKER_GROUP_EXISTS:-1}" == 1 ]]; then
    printf 'docker:x:999:\n'
  else
    return 2
  fi
}
run_groupadd() { log_command groupadd "$@"; maybe_fail groupadd "$@"; }
run_usermod() { log_command usermod "$@"; maybe_fail usermod "$@"; }
run_install() { log_command install "$@"; command install "$@"; }
run_mv() { log_command mv "$@"; command mv "$@"; }
run_rm() { log_command rm "$@"; command rm "$@"; }

main "$@"
`;

function canonicalSource(fixture, codename = 'jammy', architecture = 'amd64') {
  return [
    'Types: deb',
    'URIs: https://download.docker.com/linux/ubuntu',
    `Suites: ${codename}`,
    'Components: stable',
    `Architectures: ${architecture}`,
    `Signed-By: ${fixture.keyPath}`,
    '',
  ].join('\n');
}

function makeFixture(t, { repository = false, packages = [] } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'aerstello-docker-installer-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const aptDirectory = join(directory, 'etc/apt');
  const sourcesDirectory = join(aptDirectory, 'sources.list.d');
  const keyringDirectory = join(aptDirectory, 'keyrings');
  const keyPath = join(keyringDirectory, 'docker.asc');
  const sourcePath = join(sourcesDirectory, 'docker.sources');
  const osReleasePath = join(directory, 'os-release');
  const commandLog = join(directory, 'commands.log');
  const harness = join(directory, 'harness.sh');
  const passwdPath = join(directory, 'passwd');
  mkdirSync(sourcesDirectory, { recursive: true });
  mkdirSync(keyringDirectory, { recursive: true });
  writeFileSync(osReleasePath, 'ID=ubuntu\nUBUNTU_CODENAME=jammy\n');
  writeFileSync(join(aptDirectory, 'sources.list'), '');
  writeFileSync(commandLog, '');
  writeFileSync(passwdPath, [
    'root:x:0:0:root:/root:/bin/bash',
    'operator:x:1000:1000:Fixture Operator:/home/operator:/bin/bash',
    '',
  ].join('\n'));
  writeFileSync(harness, harnessSource, { mode: 0o755 });
  chmodSync(harness, 0o755);
  const fixture = {
    directory,
    systemEtcDirectory: join(directory, 'etc'),
    aptDirectory,
    sourcesDirectory,
    keyringDirectory,
    keyPath,
    sourcePath,
    osReleasePath,
    commandLog,
    harness,
    passwdPath,
    localCliPath: join(directory, 'usr/local/bin/docker'),
    snapCliPath: join(directory, 'snap/bin/docker'),
    systemCliPath: join(directory, 'usr/sbin/docker'),
    packagedCliPath: join(directory, 'usr/bin/docker'),
    packagedComposePluginPath: join(directory, 'usr/libexec/docker/cli-plugins/docker-compose'),
    dockerUnitPath: join(directory, 'usr/lib/systemd/system/docker.service'),
    containerdUnitPath: join(directory, 'usr/lib/systemd/system/containerd.service'),
    dataDirectory: join(directory, 'var/lib/docker'),
    containerdDirectory: join(directory, 'var/lib/containerd'),
    configDirectory: join(directory, 'etc/docker'),
    socketPath: join(directory, 'var/run/docker.sock'),
    packages,
  };
  if (packages.includes('docker-ce')) seedUnit(fixture.dockerUnitPath);
  if (packages.includes('docker-ce-cli')) seedExecutable(fixture.packagedCliPath);
  if (packages.includes('containerd.io')) seedUnit(fixture.containerdUnitPath);
  if (packages.includes('docker-compose-plugin')) seedExecutable(fixture.packagedComposePluginPath);
  if (repository) seedRepository(fixture);
  return fixture;
}

function seedExecutable(path) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  chmodSync(path, 0o755);
}

function seedUnit(path) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '[Service]\nExecStart=/usr/bin/true\n', { mode: 0o644 });
  chmodSync(path, 0o644);
}

function seedRepository(fixture) {
  writeFileSync(fixture.keyPath, [
    '-----BEGIN PGP PUBLIC KEY BLOCK-----',
    'fixture',
    '-----END PGP PUBLIC KEY BLOCK-----',
    '',
  ].join('\n'));
  writeFileSync(fixture.sourcePath, canonicalSource(fixture));
}

function run(fixture, args, environment = {}) {
  const result = spawnSync('bash', [fixture.harness, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      INSTALLER_PATH: installer,
      OS_RELEASE_PATH: fixture.osReleasePath,
      SYSTEM_ETC_DIRECTORY: fixture.systemEtcDirectory,
      APT_CONFIGURATION_DIRECTORY: fixture.aptDirectory,
      KEYRING_DIRECTORY: fixture.keyringDirectory,
      DOCKER_KEY_PATH: fixture.keyPath,
      APT_SOURCES_DIRECTORY: fixture.sourcesDirectory,
      DOCKER_SOURCE_PATH: fixture.sourcePath,
      APT_MAIN_SOURCE_PATH: join(fixture.aptDirectory, 'sources.list'),
      DOCKER_SOCKET_PATH: fixture.socketPath,
      DOCKER_DATA_DIRECTORY: fixture.dataDirectory,
      CONTAINERD_DATA_DIRECTORY: fixture.containerdDirectory,
      DOCKER_CONFIG_DIRECTORY: fixture.configDirectory,
      LOCAL_PASSWD_PATH: fixture.passwdPath,
      LOCAL_DOCKER_CLI_PATH: fixture.localCliPath,
      SNAP_DOCKER_CLI_PATH: fixture.snapCliPath,
      SYSTEM_DOCKER_CLI_PATH: fixture.systemCliPath,
      PACKAGED_DOCKER_CLI_PATH: fixture.packagedCliPath,
      PACKAGED_COMPOSE_PLUGIN_PATH: fixture.packagedComposePluginPath,
      FAKE_DOCKER_UNIT_PATH: fixture.dockerUnitPath,
      FAKE_CONTAINERD_UNIT_PATH: fixture.containerdUnitPath,
      FAKE_COMMAND_LOG: fixture.commandLog,
      FAKE_INSTALLED_PACKAGES: fixture.packages.join(' '),
      FAKE_UID: '0',
      FAKE_UNAME: 'Linux',
      FAKE_ARCH: 'amd64',
      FAKE_SYSTEMD: 'healthy',
      FAKE_SERVICE_FAILURE: '',
      FAKE_DOCKER_FRAGMENT_OVERRIDE: '__default__',
      FAKE_CONTAINERD_FRAGMENT_OVERRIDE: '__default__',
      FAKE_DOCKER_DROP_INS: '',
      FAKE_CONTAINERD_DROP_INS: '',
      FAKE_DOCKER_FAILURE: '',
      FAKE_COMPOSE_FAILURE: '',
      FAKE_USER_EXISTS: '1',
      FAKE_USER_UID: '1000',
      FAKE_DOCKER_GROUP_EXISTS: '1',
      ...environment,
    },
  });
  return { ...result, output: `${result.stdout}${result.stderr}` };
}

function commands(fixture) {
  return readFileSync(fixture.commandLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => line.trimEnd());
}

function mutatingCommands(fixture) {
  return commands(fixture).filter((line) => /^(apt-get|curl|install|mv|rm|groupadd|usermod)\b/u.test(line)
    || /^systemctl enable\b/u.test(line));
}

test('help succeeds without host or privilege checks', (t) => {
  const fixture = makeFixture(t);
  const result = run(fixture, ['--help'], { FAKE_UID: '1000', FAKE_UNAME: 'Darwin' });
  assert.equal(result.status, 0, `${result.output}\n${commands(fixture).join('\n')}`);
  assert.match(result.stdout, /--install/u);
  assert.match(result.stdout, /--grant-docker-group USER/u);
  assert.deepEqual(commands(fixture), []);
});

test('rejects missing, repeated, inconsistent, unknown, and positional options before host checks', (t) => {
  for (const args of [
    [],
    ['--install', '--check'],
    ['--install', '--install'],
    ['--install', '--dry-run', '--dry-run'],
    ['--check', '--dry-run'],
    ['--check', '--grant-docker-group', 'operator'],
    ['--install', '--grant-docker-group'],
    ['--unknown'],
    ['--install', 'extra'],
  ]) {
    const fixture = makeFixture(t);
    const result = run(fixture, args);
    assert.equal(result.status, 1, `${args.join(' ')}\n${result.output}`);
    assert.deepEqual(commands(fixture), [], args.join(' '));
  }
});

test('operational actions require root', (t) => {
  const fixture = makeFixture(t);
  const result = run(fixture, ['--install'], { FAKE_UID: '1000' });
  assert.equal(result.status, 1);
  assert.match(result.output, /as root/u);
  assert.deepEqual(commands(fixture), ['id -u']);
});

test('rejects non-Linux, non-Ubuntu, unsafe metadata, unsupported architecture, and unavailable systemd', (t) => {
  const cases = [
    [{ FAKE_UNAME: 'Darwin' }, /Ubuntu Linux only/u],
    [{ osRelease: 'ID=debian\nVERSION_CODENAME=bookworm\n' }, /Ubuntu only/u],
    [{ osRelease: 'ID=ubuntu\nUBUNTU_CODENAME=jammy stable\n' }, /unsafe release codename/u],
    [{ FAKE_ARCH: 'riscv64' }, /does not support architecture/u],
    [{ FAKE_SYSTEMD: 'unavailable' }, /working systemd/u],
  ];
  for (const [settings, message] of cases) {
    const fixture = makeFixture(t);
    if (settings.osRelease) writeFileSync(fixture.osReleasePath, settings.osRelease);
    const result = run(fixture, ['--install', '--dry-run'], settings);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, message);
    assert.deepEqual(mutatingCommands(fixture), []);
  }
});

test('dry-run previews installation without network or mutation', (t) => {
  const fixture = makeFixture(t);
  const result = run(fixture, ['--install', '--dry-run']);
  assert.equal(result.status, 0, `${result.output}\n${commands(fixture).join('\n')}`);
  assert.match(result.output, /no network or system changes were made/u);
  assert.match(result.output, /apt-get install -y docker-ce/u);
  assert.equal(readFileSync(fixture.commandLog, 'utf8').includes('curl '), false);
  assert.deepEqual(mutatingCommands(fixture), []);
});

test('rejects conflicting packages and unmanaged data without mutation', (t) => {
  const conflict = makeFixture(t, { packages: ['docker.io', 'podman-docker'] });
  const conflictResult = run(conflict, ['--install']);
  assert.equal(conflictResult.status, 1);
  assert.match(conflictResult.output, /docker\.io/u);
  assert.match(conflictResult.output, /podman-docker/u);
  assert.deepEqual(mutatingCommands(conflict), []);

  const unmanaged = makeFixture(t);
  mkdirSync(unmanaged.dataDirectory, { recursive: true });
  writeFileSync(join(unmanaged.dataDirectory, 'unmanaged'), 'data\n');
  const unmanagedResult = run(unmanaged, ['--install']);
  assert.equal(unmanagedResult.status, 1);
  assert.match(unmanagedResult.output, /Existing Docker or containerd data/u);
  assert.deepEqual(mutatingCommands(unmanaged), []);
});

test('rejects wrong existing and downloaded Docker key fingerprints before publishing or Docker package installation', (t) => {
  const existing = makeFixture(t, { repository: true });
  const existingResult = run(existing, ['--install'], { FAKE_GPG_FINGERPRINT: '0'.repeat(40) });
  assert.equal(existingResult.status, 1);
  assert.match(existingResult.output, /expected official release key/u);
  assert.deepEqual(mutatingCommands(existing), []);
  assert.equal(readFileSync(existing.sourcePath, 'utf8'), canonicalSource(existing));

  const downloaded = makeFixture(t);
  const downloadedResult = run(downloaded, ['--install'], { FAKE_GPG_FINGERPRINT: 'F'.repeat(40) });
  assert.equal(downloadedResult.status, 1);
  assert.match(downloadedResult.output, /expected official release key/u);
  assert.equal(existsSync(downloaded.keyPath), false);
  assert.equal(existsSync(downloaded.sourcePath), false);
  assert.equal(commands(downloaded).some((line) => line === `apt-get install -y ${dockerPackages.join(' ')}`), false);
});

test('rejects an armored key containing multiple primary keys', (t) => {
  const fixture = makeFixture(t, { repository: true });
  const result = run(fixture, ['--check'], { FAKE_GPG_EXTRA_PRIMARY: '1' });
  assert.equal(result.status, 1);
  assert.match(result.output, /exactly the expected official release key/u);
  assert.deepEqual(mutatingCommands(fixture), []);
  assert.equal(commands(fixture).some((line) => line.startsWith('docker ')), false);
});

test('rejects repository source and key files with unsafe ownership or permissions', (t) => {
  for (const targetName of ['sourcePath', 'keyPath']) {
    for (const unsafe of [
      { FAKE_STAT_OWNER: '1000', message: /must be owned by root/u },
      { FAKE_STAT_MODE: '666', message: /must have mode 644/u },
      { FAKE_STAT_MODE: '600', message: /must have mode 644/u },
    ]) {
      const { message, ...environment } = unsafe;
      const fixture = makeFixture(t, { repository: true, packages: dockerPackages });
      const result = run(fixture, ['--check'], {
        FAKE_UNSAFE_STAT_PATH: fixture[targetName],
        ...environment,
      });
      assert.equal(result.status, 1, `${targetName}\n${result.output}`);
      assert.match(result.output, message);
      assert.ok(commands(fixture).some((line) => line.endsWith(`-- ${fixture[targetName]}`)));
      assert.deepEqual(mutatingCommands(fixture), []);
      assert.equal(commands(fixture).some((line) => line.startsWith('docker ')), false);
    }
  }
});

test('rejects unsafe apt directory ownership and modes across the repository path', (t) => {
  for (const targetName of [
    'systemEtcDirectory',
    'aptDirectory',
    'keyringDirectory',
    'sourcesDirectory',
  ]) {
    for (const unsafe of [
      { FAKE_STAT_OWNER: '1000', message: /must be owned by root/u },
      { FAKE_STAT_MODE: '777', message: /without special or group\/world write bits/u },
      { FAKE_STAT_MODE: '1755', message: /without special or group\/world write bits/u },
    ]) {
      const { message, ...environment } = unsafe;
      const fixture = makeFixture(t, { repository: true, packages: dockerPackages });
      const result = run(fixture, ['--check'], {
        FAKE_UNSAFE_STAT_PATH: fixture[targetName],
        ...environment,
      });
      assert.equal(result.status, 1, `${targetName}\n${result.output}`);
      assert.match(result.output, message);
      assert.deepEqual(mutatingCommands(fixture), []);
      assert.equal(commands(fixture).some((line) => line.startsWith('docker ')), false);
    }
  }
});

test('rejects missing, foreign, or mixed-origin candidates for every Docker package before package installation', (t) => {
  for (const packageName of dockerPackages) {
    for (const mode of ['none', 'foreign', 'mixed']) {
      const fixture = makeFixture(t, { repository: true });
      const result = run(fixture, ['--install'], {
        FAKE_BAD_CANDIDATE_PACKAGE: packageName,
        FAKE_BAD_CANDIDATE_MODE: mode,
      });
      assert.equal(result.status, 1, `${packageName} ${mode}\n${result.output}`);
      assert.match(result.output, mode === 'none' ? /has no .* candidate/u : /does not originate exclusively/u);
      assert.equal(commands(fixture).some((line) => line === `apt-get install -y ${dockerPackages.join(' ')}`), false);
    }
  }
});

test('rejects installed Docker package versions without exclusive cached official provenance', (t) => {
  for (const packageName of dockerPackages) {
    for (const mode of ['missing', 'foreign', 'mixed']) {
      const fixture = makeFixture(t, { repository: true, packages: dockerPackages });
      const result = run(fixture, ['--check'], {
        FAKE_BAD_INSTALLED_ORIGIN_PACKAGE: packageName,
        FAKE_BAD_INSTALLED_ORIGIN_MODE: mode,
      });
      assert.equal(result.status, 1, `${packageName} ${mode}\n${result.output}`);
      assert.match(result.output, /does not have exclusive cached provenance/u);
      assert.ok(commands(fixture).includes(`dpkg-query -W -f=\\\$\\{Version\\} ${packageName}`));
      assert.deepEqual(mutatingCommands(fixture), []);
      assert.equal(commands(fixture).some((line) => /^(?:docker|docker-compose) /u.test(line)), false);
    }
  }
});

test('rejects unmanaged system CLI and packaged executables with the wrong dpkg owner', (t) => {
  const systemCli = makeFixture(t);
  mkdirSync(dirname(systemCli.systemCliPath), { recursive: true });
  writeFileSync(systemCli.systemCliPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const systemResult = run(systemCli, ['--install']);
  assert.equal(systemResult.status, 1);
  assert.match(systemResult.output, /unmanaged Docker CLI/u);
  assert.deepEqual(mutatingCommands(systemCli), []);

  const wrongOwner = makeFixture(t, { packages: ['docker-ce-cli'] });
  mkdirSync(dirname(wrongOwner.packagedCliPath), { recursive: true });
  writeFileSync(wrongOwner.packagedCliPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const ownerResult = run(wrongOwner, ['--install'], { FAKE_CLI_OWNER: 'docker.io' });
  assert.equal(ownerResult.status, 1);
  assert.match(ownerResult.output, /not owned by docker-ce-cli/u);
  assert.ok(commands(wrongOwner).includes(`dpkg-query -S ${wrongOwner.packagedCliPath}`));
  assert.deepEqual(mutatingCommands(wrongOwner), []);

  const wrongComposeOwner = makeFixture(t, { packages: ['docker-compose-plugin'] });
  const composeOwnerResult = run(wrongComposeOwner, ['--install'], { FAKE_COMPOSE_OWNER: 'docker.io' });
  assert.equal(composeOwnerResult.status, 1);
  assert.match(composeOwnerResult.output, /not owned by docker-compose-plugin/u);
  assert.ok(commands(wrongComposeOwner).includes(`dpkg-query -S ${wrongComposeOwner.packagedComposePluginPath}`));
  assert.deepEqual(mutatingCommands(wrongComposeOwner), []);
});

test('rejects packaged Docker and Compose executables with unsafe ownership or permissions', (t) => {
  for (const target of [
    { packageName: 'docker-ce-cli', pathName: 'packagedCliPath' },
    { packageName: 'docker-compose-plugin', pathName: 'packagedComposePluginPath' },
  ]) {
    for (const unsafe of [
      { FAKE_STAT_OWNER: '1000', message: /must be owned by root/u },
      { FAKE_STAT_MODE: '775', message: /must have mode 755/u },
      { FAKE_STAT_MODE: '4755', message: /must have mode 755/u },
    ]) {
      const { message, ...environment } = unsafe;
      const fixture = makeFixture(t, { packages: [target.packageName] });
      const targetPath = fixture[target.pathName];
      const result = run(fixture, ['--install'], {
        FAKE_UNSAFE_STAT_PATH: targetPath,
        ...environment,
      });
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, message);
      assert.ok(commands(fixture).includes(`stat --format=%u\\ %a -- ${targetPath}`));
      assert.deepEqual(mutatingCommands(fixture), []);
      assert.equal(commands(fixture).some((line) => /^(?:docker|docker-compose) /u.test(line)), false);
    }
  }
});

test('rejects missing or unpackaged fixed Compose payloads before execution', (t) => {
  const missing = makeFixture(t, { packages: ['docker-compose-plugin'] });
  rmSync(missing.packagedComposePluginPath);
  const missingResult = run(missing, ['--install']);
  assert.equal(missingResult.status, 1);
  assert.match(missingResult.output, /missing, linked, or not executable/u);
  assert.equal(commands(missing).some((line) => line.startsWith('docker-compose ')), false);

  const unpackaged = makeFixture(t);
  seedExecutable(unpackaged.packagedComposePluginPath);
  const unpackagedResult = run(unpackaged, ['--install']);
  assert.equal(unpackagedResult.status, 1);
  assert.match(unpackagedResult.output, /exists without its official package/u);
  assert.deepEqual(mutatingCommands(unpackaged), []);
});

test('rejects shadowed, overridden, or unsafe Docker systemd units before service execution', (t) => {
  const shadowed = makeFixture(t);
  const shadowPath = join(shadowed.directory, 'etc/systemd/system/docker.service');
  seedUnit(shadowPath);
  const shadowResult = run(shadowed, ['--install'], { FAKE_DOCKER_FRAGMENT_OVERRIDE: shadowPath });
  assert.equal(shadowResult.status, 1);
  assert.match(shadowResult.output, /unmanaged systemd unit/u);
  assert.deepEqual(mutatingCommands(shadowed), []);

  const overridden = makeFixture(t, { repository: true, packages: dockerPackages });
  const overrideResult = run(overridden, ['--check'], {
    FAKE_DOCKER_DROP_INS: '/etc/systemd/system/docker.service.d/override.conf',
  });
  assert.equal(overrideResult.status, 1);
  assert.match(overrideResult.output, /unmanaged systemd drop-ins/u);
  assert.equal(commands(overridden).some((line) => /^systemctl (?:enable|is-)/u.test(line)), false);
  assert.equal(commands(overridden).some((line) => /^(?:docker|docker-compose) /u.test(line)), false);

  const wrongOwner = makeFixture(t, { repository: true, packages: dockerPackages });
  const ownerResult = run(wrongOwner, ['--check'], { FAKE_DOCKER_UNIT_OWNER: 'local-unit' });
  assert.equal(ownerResult.status, 1);
  assert.match(ownerResult.output, /systemd unit is not owned by docker-ce/u);

  const unsafeMode = makeFixture(t, { repository: true, packages: dockerPackages });
  const modeResult = run(unsafeMode, ['--check'], {
    FAKE_UNSAFE_STAT_PATH: unsafeMode.containerdUnitPath,
    FAKE_STAT_MODE: '666',
  });
  assert.equal(modeResult.status, 1);
  assert.match(modeResult.output, /containerd systemd unit must have mode 644/u);
  assert.equal(commands(unsafeMode).some((line) => /^systemctl (?:enable|is-)/u.test(line)), false);
});

test('rejects tampered installed and newly installed Docker packages before service or Docker execution', (t) => {
  const existing = makeFixture(t, { repository: true, packages: dockerPackages });
  const existingResult = run(existing, ['--check'], { FAKE_TAMPERED_PACKAGE: 'docker-ce-cli' });
  assert.equal(existingResult.status, 1);
  assert.match(existingResult.output, /failed dpkg integrity verification: docker-ce-cli/u);
  assert.ok(commands(existing).includes('dpkg --verify docker-ce-cli'));
  assert.equal(commands(existing).some((line) => /^systemctl (?:is-|enable)/u.test(line)), false);
  assert.equal(commands(existing).some((line) => line.startsWith('docker ')), false);

  const newlyInstalled = makeFixture(t, { repository: true });
  const installResult = run(newlyInstalled, ['--install'], { FAKE_TAMPERED_PACKAGE: 'containerd.io' });
  assert.equal(installResult.status, 1);
  assert.match(installResult.output, /failed dpkg integrity verification: containerd\.io/u);
  assert.ok(commands(newlyInstalled).includes(`apt-get install -y ${dockerPackages.join(' ')}`));
  assert.ok(commands(newlyInstalled).includes('dpkg --verify containerd.io'));
  assert.equal(commands(newlyInstalled).some((line) => line === 'systemctl enable --now docker.service containerd.service'), false);
  assert.equal(commands(newlyInstalled).some((line) => line.startsWith('docker ')), false);
});

test('fresh install creates the canonical repository and installs exact packages in order', (t) => {
  const fixture = makeFixture(t);
  const result = run(fixture, ['--install']);
  assert.equal(result.status, 0, result.output);
  assert.equal(readFileSync(fixture.sourcePath, 'utf8'), canonicalSource(fixture));
  assert.match(readFileSync(fixture.keyPath, 'utf8'), /BEGIN PGP PUBLIC KEY BLOCK/u);
  const log = commands(fixture);
  assert.deepEqual(log.filter((line) => line.startsWith('apt-get ')).slice(0, 2), [
    'apt-get update',
    'apt-get install -y ca-certificates curl gnupg',
  ]);
  const curlIndex = log.findIndex((line) => line.startsWith('curl '));
  const refreshIndex = log.findIndex((line, index) => index > curlIndex && line === 'apt-get update');
  const packageLine = `apt-get install -y ${dockerPackages.join(' ')}`;
  const packageIndex = log.indexOf(packageLine);
  const serviceIndex = log.indexOf('systemctl enable --now docker.service containerd.service');
  assert.ok(curlIndex > 1, log.join('\n'));
  assert.ok(refreshIndex > curlIndex, log.join('\n'));
  assert.ok(packageIndex > refreshIndex, log.join('\n'));
  assert.ok(serviceIndex > packageIndex, log.join('\n'));
});

test('fresh install creates a missing apt source directory before validating it', (t) => {
  const fixture = makeFixture(t);
  rmSync(fixture.sourcesDirectory, { recursive: true });
  const result = run(fixture, ['--install']);
  assert.equal(result.status, 0, result.output);
  assert.equal(readFileSync(fixture.sourcePath, 'utf8'), canonicalSource(fixture));
  assert.ok(commands(fixture).includes(`install -d -m 0755 -- ${fixture.sourcesDirectory}`));
  assert.ok(commands(fixture).includes(`stat --format=%u\\ %a -- ${fixture.sourcesDirectory}`));
});

test('propagates command failures and does not report success', (t) => {
  const fixture = makeFixture(t);
  const result = run(fixture, ['--install'], { FAKE_FAIL_MATCH: 'apt-get install -y docker-ce' });
  assert.equal(result.status, 41, result.output);
  assert.match(result.output, /injected failure/u);
  assert.doesNotMatch(result.output, /installed and healthy/u);
  assert.equal(commands(fixture).some((line) => line === 'systemctl enable --now docker.service containerd.service'), false);
});

test('healthy install is a package and repository no-op but still verifies services', (t) => {
  const fixture = makeFixture(t, { repository: true, packages: dockerPackages });
  const result = run(fixture, ['--install']);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /already healthy/u);
  assert.equal(commands(fixture).some((line) => /^(apt-get|curl|install|mv)\b/u.test(line)), false);
  assert.ok(commands(fixture).includes('docker version'));
  assert.ok(commands(fixture).includes('docker-compose version'));
  assert.equal(commands(fixture).includes('docker info'), false);
});

test('upgrade is explicit and uses only-upgrade for the exact package set', (t) => {
  const fixture = makeFixture(t, { repository: true, packages: dockerPackages });
  const result = run(fixture, ['--upgrade']);
  assert.equal(result.status, 0, result.output);
  const log = commands(fixture);
  assert.ok(log.includes('apt-get update'));
  assert.ok(log.includes(`apt-get install -y --only-upgrade ${dockerPackages.join(' ')}`));
  assert.equal(log.some((line) => line.startsWith('curl ')), false);
});

test('check fails when daemon or Compose verification fails', (t) => {
  const fixture = makeFixture(t, { repository: true, packages: dockerPackages });
  const result = run(fixture, ['--check'], { FAKE_COMPOSE_FAILURE: 'version' });
  assert.equal(result.status, 1);
  assert.match(result.output, /not healthy/u);
  assert.deepEqual(mutatingCommands(fixture), []);
});

test('docker-group membership is default-off and explicit for a validated target', (t) => {
  const defaultFixture = makeFixture(t, { repository: true, packages: dockerPackages });
  assert.equal(run(defaultFixture, ['--install']).status, 0);
  assert.equal(commands(defaultFixture).some((line) => line.startsWith('usermod ')), false);

  const explicitFixture = makeFixture(t, { repository: true, packages: dockerPackages });
  writeFileSync(explicitFixture.passwdPath, [
    'operator:x:1000:1000:Fixture Operator:/home/operator:/bin/bash',
    'root:x:0:0:root:/root:/bin/bash',
    '',
  ].join('\n'));
  const explicit = run(explicitFixture, ['--install', '--grant-docker-group', 'operator']);
  assert.equal(explicit.status, 0, explicit.output);
  assert.match(explicit.output, /root-equivalent access/u);
  assert.match(explicit.output, /Log out and back in/u);
  assert.ok(commands(explicitFixture).includes('usermod -aG docker operator'));

  const rootFixture = makeFixture(t, { repository: true, packages: dockerPackages });
  const rootGrant = run(rootFixture, ['--install', '--grant-docker-group', 'root']);
  assert.equal(rootGrant.status, 1);
  assert.match(rootGrant.output, /cannot be granted to the root/u);
  assert.equal(commands(rootFixture).some((line) => line.startsWith('usermod ')), false);
});

test('installer contains no pipe-to-shell or Docker data removal behavior', () => {
  const source = readFileSync(installer, 'utf8');
  assert.doesNotMatch(source, /curl[^\n|]*\|\s*(?:ba)?sh\b/u);
  assert.doesNotMatch(source, /(?:rm|run_rm)[^\n]*(?:\/var\/lib\/docker|DOCKER_DATA_DIRECTORY|CONTAINERD_DATA_DIRECTORY)/u);
  assert.doesNotMatch(source, /docker\s+(?:system\s+)?prune\b/u);
  assert.match(source, /command env -i PATH="\$TRUSTED_PATH" LC_ALL=C HOME="\$STATELESS_GPG_HOME"/u);
  assert.match(source, /"\$PACKAGED_DOCKER_CLI_PATH" --config "\$STATELESS_GPG_HOME"/u);
  assert.match(source, /--host "unix:\/\/\$DOCKER_SOCKET_PATH"/u);
  assert.match(source, /"\$PACKAGED_COMPOSE_PLUGIN_PATH" "\$@"/u);
  assert.doesNotMatch(source, /run_local_docker info/u);
  assert.doesNotMatch(source, /run_local_docker compose/u);
  assert.match(source, /--homedir "\$STATELESS_GPG_HOME" --no-options --no-default-keyring/u);
  assert.match(source, /--no-keyring --trust-model always --lock-never/u);
  assert.doesNotMatch(source, /aerstello-docker-gpg/u);
});
