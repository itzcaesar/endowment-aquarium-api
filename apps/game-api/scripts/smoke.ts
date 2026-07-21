const gameUrl = process.env.GAME_API_URL ?? 'http://localhost:3000';
const mockUrl = process.env.MOCK_API_URL ?? 'http://localhost:4000';

async function check(url: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
}

await check(`${gameUrl}/api/v1/health`);
await check(`${mockUrl}/health`);
await check(`${gameUrl}/api/v1/big-aquarium?limit=15`);
process.stdout.write(`Smoke checks passed for ${gameUrl} and ${mockUrl}.\n`);
