#!/usr/bin/env node
/**
 * clasp 로 새 배포를 만들고, 나온 URL 을 docs/config.js 에 자동 반영한다.
 *
 * 수동으로 하면 배포는 했는데 config 갱신을 빠뜨려서
 * 화면이 옛 버전을 계속 바라보는 일이 생긴다. 실제로 겪었다.
 *
 *   node scripts/deploy.js "설명"
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const configPath = path.join(root, 'docs', 'config.js');
const description = process.argv[2] || 'update';

// Windows 에서는 shell 을 거치는데, 그러면 공백이 든 인자가 쪼개진다.
// ('스파크라인 추가' → '스파크라인' + '추가' 로 분해되어 인자 수가 안 맞는다.)
// 셸에 넘길 때만 따옴표로 감싼다.
function run(args) {
  const useShell = process.platform === 'win32';
  const finalArgs = useShell
    ? args.map(function (a) {
        return /\s/.test(a) ? '"' + a.replace(/"/g, '\\"') + '"' : a;
      })
    : args;

  return execFileSync('npx', finalArgs, {
    cwd: root,
    encoding: 'utf8',
    shell: useShell,
  });
}

console.log('· 코드 업로드');
process.stdout.write(run(['clasp', 'push', '--force']));

console.log('· 새 배포 생성');
// clasp 3.x 의 create-deployment 는 위치 인자를 받지 않는다.
// 설명은 -d 플래그로만 넘길 수 있다.
const out = run(['clasp', 'create-deployment', '-d', description]);
process.stdout.write(out);

// "Deployed AKfycb... @13" 에서 배포 ID 만 뽑는다.
const match = out.match(/Deployed\s+(AKfycb[\w-]+)/);
if (!match) {
  console.error('배포 ID 를 찾지 못했습니다. config.js 를 직접 확인하세요.');
  process.exit(1);
}

const url = `https://script.google.com/macros/s/${match[1]}/exec`;
const config = fs.readFileSync(configPath, 'utf8');
const updated = config.replace(
  /https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec/,
  url
);

if (updated === config) {
  console.log('· config.js 변경 없음 (이미 최신)');
} else {
  fs.writeFileSync(configPath, updated);
  console.log('· config.js 갱신 완료');
}

console.log('\n배포 URL:', url);
console.log('Pages 에 반영하려면 커밋 후 push 하세요.');
