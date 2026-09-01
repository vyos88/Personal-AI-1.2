export const type = 'echo';

export const description = 'Returns its payload unchanged. Useful for proving the tunnel end to end.';

export async function run(payload) {
  return { echoed: payload, at: new Date().toISOString() };
}
