#!/usr/bin/env node

import console from 'node:console';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(scriptDir, '..');

export function validateReleaseVersion(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('release/version.json은 객체여야 한다');
  }

  const { version, build } = value;
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error('version은 앞자리 0이 없는 major.minor.patch 형식이어야 한다');
  }
  if (version.split('.').some((component) => Number(component) > 65_535)) {
    throw new Error('version의 각 숫자는 Windows 버전 구성요소 상한 65535를 넘을 수 없다');
  }
  if (!Number.isSafeInteger(build) || build < 1) {
    throw new Error('build는 1 이상의 안전한 정수여야 한다');
  }
  if (build > 9_999) {
    throw new Error('build는 macOS CFBundleVersion 첫 구성요소 상한 9999를 넘을 수 없다');
  }

  return { version, build };
}

export function readReleaseVersion(root = defaultRoot) {
  const path = resolve(root, 'release/version.json');
  return validateReleaseVersion(JSON.parse(readFileSync(path, 'utf8')));
}

export function windowsFileVersion(release) {
  return `${release.version}.${release.build}`;
}

function requireText(path, expected, label) {
  const contents = readFileSync(path, 'utf8');
  if (!contents.includes(expected)) {
    throw new Error(`${label}에 '${expected}'가 없다`);
  }
}

export function checkReleaseProjection(root = defaultRoot) {
  const release = readReleaseVersion(root);
  const macPackage = JSON.parse(readFileSync(resolve(root, 'apps/macos-ime/package.json'), 'utf8'));
  if (macPackage.version !== release.version) {
    throw new Error(`macOS package version ${macPackage.version} != ${release.version}`);
  }

  requireText(
    resolve(root, 'apps/windows-ime/Cargo.toml'),
    `version = "${release.version}"`,
    'Windows Cargo.toml',
  );
  requireText(
    resolve(root, 'apps/macos-ime/Resources/Info.plist'),
    '<string>@@JIEUM_VERSION@@</string>',
    'macOS Info.plist',
  );
  requireText(
    resolve(root, 'apps/macos-ime/Resources/Info.plist'),
    '<string>@@JIEUM_BUILD@@</string>',
    'macOS Info.plist',
  );
  requireText(resolve(root, 'README.md'), `v${release.version}`, 'README');
  requireText(resolve(root, 'apps/landing/public/index.html'), `v${release.version}`, '랜딩페이지');
  requireText(
    resolve(root, 'apps/windows-ime/installer/Jieum.iss'),
    'VersionInfoVersion={#MyAppFileVersion}',
    'Windows installer',
  );

  return release;
}

function main(args) {
  const command = args[0] ?? 'check';
  const release = command === 'check' ? checkReleaseProjection() : readReleaseVersion();
  switch (command) {
    case 'check':
      console.log(`RELEASE_VERSION_OK ${release.version} (${release.build})`);
      return 0;
    case 'version':
      console.log(release.version);
      return 0;
    case 'build':
      console.log(release.build);
      return 0;
    case 'windows':
      console.log(windowsFileVersion(release));
      return 0;
    case 'display':
      console.log(`${release.version} (${release.build})`);
      return 0;
    default:
      throw new Error(`모르는 명령: ${command}`);
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === realpathSync(process.argv[1])
) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`release version error: ${error.message}`);
    process.exitCode = 1;
  }
}
