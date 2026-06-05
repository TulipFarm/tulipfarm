import Fastify from 'fastify'

const app = Fastify({ logger: true })

app.get('/health', async () => ({ status: 'ok' }))

app.listen({ port: 3001, host: '0.0.0.0' }, (err) => {
  if (err) {
    app.log.error(err)
    process.exit(1)
  }
})
