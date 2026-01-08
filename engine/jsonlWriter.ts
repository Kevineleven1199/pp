import * as fs from 'fs'
import * as path from 'path'

export class JsonlRotatingWriter<T> {
  private currentKey: string | null = null
  private stream: fs.WriteStream | null = null
  private dedupKeys: Set<string> | null = null

  constructor(
    private readonly makeFilePath: (dateKey: string) => string,
    private readonly getDedupKey?: (obj: T) => string | number
  ) {}

  write(obj: T, timestampMs: number): boolean {
    const key = new Date(timestampMs).toISOString().slice(0, 10)
    if (this.currentKey !== key) {
      this.rotate(key)
    }

    if (this.getDedupKey && this.dedupKeys) {
      const k = String(this.getDedupKey(obj))
      if (this.dedupKeys.has(k)) return false
      this.dedupKeys.add(k)
    }

    this.stream?.write(JSON.stringify(obj) + '\n')
    return true
  }

  close() {
    this.stream?.end()
    this.stream = null
    this.currentKey = null
    this.dedupKeys = null
  }

  private rotate(key: string) {
    this.stream?.end()

    const filePath = this.makeFilePath(key)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })

    if (this.getDedupKey) {
      const set = new Set<string>()
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf8')
        for (const line of raw.split(/\r?\n/)) {
          const t = line.trim()
          if (!t) continue
          try {
            const obj = JSON.parse(t) as T
            set.add(String(this.getDedupKey(obj)))
          } catch {
          }
        }
      }
      this.dedupKeys = set
    } else {
      this.dedupKeys = null
    }

    this.stream = fs.createWriteStream(filePath, { flags: 'a' })
    this.currentKey = key
  }
}
