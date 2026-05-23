import fs from 'node:fs';
import path from 'node:path';

export interface StackPlan {
  stack: string;
  ports: number[];
}

function exists(repoPath: string, file: string): boolean {
  return fs.existsSync(path.join(repoPath, file));
}

function findFirstFile(repoPath: string, names: string[], depth = 3): string | undefined {
  function walk(dir: string, level: number): string | undefined {
    if (level > depth) return undefined;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return path.relative(repoPath, candidate);
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name === '.git') continue;
      const found = walk(path.join(dir, entry.name), level + 1);
      if (found) return found;
    }
    return undefined;
  }
  return walk(repoPath, 0);
}

export function planForRepo(repoPath: string): StackPlan {
  if (exists(repoPath, 'cms')) return { stack: 'Linux CMS Binary', ports: [21007, 80, 443] };
  if (exists(repoPath, 'package.json')) return { stack: 'Node.js', ports: [3000, 5173, 8080, 8000] };
  if (exists(repoPath, 'requirements.txt') || exists(repoPath, 'pyproject.toml') || findFirstFile(repoPath, ['manage.py', 'app.py', 'main.py'])) {
    return { stack: 'Python', ports: [8000, 5000] };
  }
  if (exists(repoPath, 'composer.json') || findFirstFile(repoPath, ['index.php'])) return { stack: 'PHP', ports: [8000, 80] };
  if (exists(repoPath, 'go.mod')) return { stack: 'Go', ports: [8080, 8000] };
  if (exists(repoPath, 'pom.xml') || exists(repoPath, 'build.gradle') || exists(repoPath, 'build.gradle.kts')) return { stack: 'Java', ports: [8080] };
  return { stack: 'Static', ports: [8000, 8080] };
}
