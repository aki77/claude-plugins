#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

const PACKAGE_MANAGERS = [
  {
    name: 'npm',
    lockFile: 'package-lock.json',
    commands: ['npm']
  },
  {
    name: 'yarn',
    lockFile: 'yarn.lock',
    commands: ['yarn', 'yarnpkg']
  },
  {
    name: 'pnpm',
    lockFile: 'pnpm-lock.yaml',
    commands: ['pnpm', 'pnpx']
  }
];

// 常に許容するコマンド
const ALWAYS_ALLOWED_COMMANDS = ['npx'];

function findProjectRoot(startPath) {
  let currentPath = startPath;
  
  while (currentPath !== path.dirname(currentPath)) {
    const packageJsonPath = path.join(currentPath, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      return currentPath;
    }
    currentPath = path.dirname(currentPath);
  }
  
  return null;
}

function detectPackageManager(projectRoot) {
  // package.json の packageManager フィールドをチェック
  const packageJsonPath = path.join(projectRoot, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      if (packageJson.packageManager) {
        const manager = packageJson.packageManager.split('@')[0];
        return manager;
      }
    } catch (error) {
      console.error('package.json の解析に失敗しました:', error);
    }
  }

  // ロックファイルから推測
  for (const pm of PACKAGE_MANAGERS) {
    const lockFilePath = path.join(projectRoot, pm.lockFile);
    if (fs.existsSync(lockFilePath)) {
      return pm.name;
    }
  }

  return null;
}

function extractCommand(commandString) {
  const parts = commandString.trim().split(/\s+/);
  if (parts.length === 0) return null;
  
  const command = parts[0];
  
  // 常に許容するコマンドかチェック
  if (ALWAYS_ALLOWED_COMMANDS.includes(command)) {
    return 'allowed';
  }
  
  // パッケージマネージャーコマンドかチェック
  for (const pm of PACKAGE_MANAGERS) {
    if (pm.commands.includes(command)) {
      return command;
    }
  }
  
  return null;
}

function getPackageManagerFromCommand(command) {
  for (const pm of PACKAGE_MANAGERS) {
    if (pm.commands.includes(command)) {
      return pm.name;
    }
  }
  return null;
}

function readStdinAsJson() {
  return new Promise((resolve, reject) => {
    let input = '';
    
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      input += chunk;
    });
    
    process.stdin.on('end', () => {
      try {
        const data = JSON.parse(input);
        resolve(data);
      } catch (error) {
        reject(error);
      }
    });
    
    process.stdin.on('error', (error) => {
      reject(error);
    });
  });
}

async function main() {
  try {
    // stdinからJSONデータを読み取り
    const hookData = await readStdinAsJson();
    
    // Bashコマンドでない場合は許可
    if (hookData.tool_name !== 'Bash') {
      process.exit(0);
    }
    
    const commandString = hookData.tool_input?.command || '';
    const command = extractCommand(commandString);
    
    if (!command) {
      // パッケージマネージャーコマンドでない場合は許可
      process.exit(0);
    }
    
    if (command === 'allowed') {
      // 常に許容するコマンドの場合は許可
      process.exit(0);
    }
    
    const projectRoot = findProjectRoot(process.cwd());
    
    if (!projectRoot) {
      console.error('package.json が見つかりません。JavaScriptプロジェクトではない可能性があります。');
      process.exit(0);
    }
    
    const detectedManager = detectPackageManager(projectRoot);
    const commandManager = getPackageManagerFromCommand(command);
    
    if (!detectedManager) {
      console.warn(`警告: プロジェクトのパッケージマネージャーを特定できませんでした。${command} の実行を許可します。`);
      process.exit(0);
    }
    
    if (detectedManager !== commandManager) {
      console.error(`❌ パッケージマネージャーの不一致が検出されました!`);
      console.error(`   プロジェクトで使用されているパッケージマネージャー: ${detectedManager}`);
      console.error(`   実行しようとしているコマンド: ${command} (${commandManager})`);
      console.error(`   正しいコマンドを使用してください。`);
      
      // 推奨コマンドを表示
      if (detectedManager === 'npm' && commandManager === 'yarn') {
        console.error(`   例: yarn install → npm install`);
      } else if (detectedManager === 'yarn' && commandManager === 'npm') {
        console.error(`   例: npm install → yarn install`);
      } else if (detectedManager === 'pnpm' && commandManager === 'npm') {
        console.error(`   例: npm install → pnpm install`);
      } else if (detectedManager === 'pnpm' && commandManager === 'yarn') {
        console.error(`   例: yarn install → pnpm install`);
      }
      
      process.exit(2);
    }
    
    console.log(`✅ パッケージマネージャーチェック完了: ${detectedManager}`);
    process.exit(0);
    
  } catch (error) {
    console.error('エラーが発生しました:', error);
    process.exit(2);
  }
}

main();