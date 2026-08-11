import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const gifsDirectory = join(repositoryRoot, 'public', 'gifs')

mkdirSync(gifsDirectory, { recursive: true })

for (const name of ['image31.GIF', 'image32.GIF']) {
  const partNames = readdirSync(gifsDirectory)
    .filter((entry) => entry.startsWith(`${name}.part`))
    .sort()
  if (!partNames.length) throw new Error(`No transport parts found for ${name}`)
  const bytes = Buffer.concat(partNames.map((partName) => readFileSync(join(gifsDirectory, partName))))
  writeFileSync(join(gifsDirectory, name), bytes)
  process.stdout.write(`assembled ${name} (${bytes.length} bytes)\n`)
}
