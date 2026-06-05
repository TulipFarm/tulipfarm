import { Db } from 'mongodb'

export interface DataMigration {
  version: number
  description: string
  up: (db: Db) => Promise<void>
}

export const DATA_MIGRATIONS: DataMigration[] = []
