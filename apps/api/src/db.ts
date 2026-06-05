import { MongoClient, Db } from 'mongodb'

let client: MongoClient
let db: Db

export async function connectDb(): Promise<{ client: MongoClient; db: Db }> {
  client = new MongoClient(process.env.MONGODB_URI!)
  await client.connect()
  db = client.db()
  return { client, db }
}

export function getDb(): Db {
  return db
}
