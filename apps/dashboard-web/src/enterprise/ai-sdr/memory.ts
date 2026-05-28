export type MemoryRecord = {
  contactId: string
  key: string
  value: string
  updatedAt: string
}

class ConversationMemory {
  private records = new Map<string, MemoryRecord>()

  upsert(record: MemoryRecord) {
    this.records.set(`${record.contactId}:${record.key}`, record)
  }

  findByContact(contactId: string) {
    return Array.from(this.records.values()).filter((record) => record.contactId === contactId)
  }
}

export const conversationMemory = new ConversationMemory()
