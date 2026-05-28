import { logger } from '../observability/logger'
import { withRetry, type RetryPolicy } from './retry'

type Job = {
  id: string
  type: string
  run: () => Promise<void>
  retryPolicy: RetryPolicy
}

class JobQueue {
  private queue: Job[] = []
  private running = false

  enqueue(job: Job) {
    this.queue.push(job)
    void this.drain()
  }

  private async drain() {
    if (this.running) {
      return
    }

    this.running = true
    while (this.queue.length > 0) {
      const job = this.queue.shift()
      if (job) {
        await withRetry(job.run, job.retryPolicy)
        logger.info('background_job_completed', { id: job.id, type: job.type })
      }
    }
    this.running = false
  }
}

export const jobQueue = new JobQueue()
