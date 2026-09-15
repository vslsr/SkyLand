const DEFAULT_MAXIMUM_BYTES = 4096;

/**
 * 读取并解析请求体 JSON。
 *
 * 超过上限直接抛错而不是继续收：请求体是外部输入，没有上限的累积等于把内存交给调用方。
 */
export async function readJsonBody(request, maximumBytes = DEFAULT_MAXIMUM_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) throw new Error('请求内容过大');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
