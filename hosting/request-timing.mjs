const round = value => Math.round(value * 10) / 10;

// Cloudflare's clock advances on I/O. Measure elapsed phases, and leave CPU time
// to the runtime logs. Concurrent reads contribute once to elapsed R2 time.
export function requestTiming(bucket) {
  const start = performance.now();
  const r2 = {pending: 0, since: 0, ms: 0};
  const inflate = {pending: 0, since: 0, ms: 0};
  const io = {pending: 0, since: 0, ms: 0};
  let reads = 0, bytes = 0, inflatedBytes = 0, open = 0;
  const waiting = [];
  const measure = async (phase, work) => {
    const begin = performance.now();
    for (const p of [phase, io]) if (p.pending++ === 0) p.since = begin;
    try {
      return await work();
    } finally {
      const end = performance.now();
      for (const p of [phase, io]) if (--p.pending === 0) p.ms += end - p.since;
    }
  };
  // Hold the slot until the body is drained, not just until R2 sends headers.
  async function read(key, options, buffer = true) {
    if (open < 6) open++;
    else await new Promise(resolve => waiting.push(resolve));
    try {
      return await measure(r2, async () => {
        reads++;
        const object = await bucket.get(key, options);
        if (!object) return null;
        if (!buffer) {
          bytes += object.size;
          return object;
        }
        const body = await object.arrayBuffer();
        bytes += body.byteLength;
        return body;
      });
    } finally {
      const next = waiting.shift();
      if (next) next();
      else open--;
    }
  }
  return {
    read,
    unzip: body => measure(inflate, async () => {
      const result = await new Response(
        new Blob([body]).stream().pipeThrough(new DecompressionStream('gzip')),
      ).arrayBuffer();
      inflatedBytes += result.byteLength;
      return result;
    }),
    finish(request, route, response) {
      const total = performance.now() - start;
      const metrics = {total: round(total), r2: round(r2.ms), inflate: round(inflate.ms),
        other: round(Math.max(0, total - io.ms)), reads, bytes, inflatedBytes};
      response.headers.set('Server-Timing', [
        `worker;dur=${metrics.total}`, `r2;dur=${metrics.r2};desc="${reads} reads, ${bytes} bytes"`,
        `inflate;dur=${metrics.inflate};desc="${inflatedBytes} output bytes"`, `other;dur=${metrics.other}`,
      ].join(', '));
      console.log(JSON.stringify({event: 'rjt.request', route, method: request.method,
        status: response.status, ...metrics}));
      return response;
    },
  };
}
