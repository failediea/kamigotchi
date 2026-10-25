#!/usr/bin/env node
// Remote read-only baseline: no Wallet, signer, transaction, or secret output.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const root = process.argv.find((v) => v.startsWith('--root='))?.slice(7) || '/root/kamigotchi/tools';
const { Contract, JsonRpcProvider, FetchRequest, ZeroAddress } = await import(pathToFileURL(`${root}/vault-kit/node_modules/ethers/lib.esm/index.js`));
const rows = [];
for (const stack of ['v16-musu', 'v16-vipp', 'v15-musu', 'v15-vipp']) {
  const env = {};
  for (const line of readFileSync(`${root}/vault-kit-${stack}/.env`, 'utf8').split('\n')) {
    const match = line.trim().match(/^([A-Z_]+)=(.*)$/);
    if (match && ['YOMINET_RPC', 'MARKET_ADDRESS', 'RENTER_POD_FACTORY'].includes(match[1])) env[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  let provider;
  try {
    if (!env.YOMINET_RPC || !env.MARKET_ADDRESS || !env.RENTER_POD_FACTORY) throw new Error('missing public config');
    const request = new FetchRequest(env.YOMINET_RPC); request.timeout = 15000;
    provider = new JsonRpcProvider(request);
    const market = new Contract(env.MARKET_ADDRESS, [
      'function numListings() view returns(uint256)', 'function tokenIndices(uint256) view returns(uint32)',
      'function listings(uint32) view returns(tuple(address owner,uint256 kamiID,uint256 xpBase,uint16 ownerShareBps,uint128 minGasWei,bool staked,bool returning,bool ending,address renter,uint256 gasBudget,uint32 maxTermSecs,uint64 leaseStart,uint64 leaseEnd,address reservedFor))',
      'function lastSettleAt() view returns(uint64)', 'function settler() view returns(address)',
    ], provider);
    const factory = new Contract(env.RENTER_POD_FACTORY, ['function keeper() view returns(address)', 'function requests(uint32) view returns(address renter,address pod,uint256 gasBudget,uint32 termSecs,uint64 requestedAt,uint8 stage)'], provider);
    const [count, lastSettleAt, settler, keeper] = await Promise.all([market.numListings(), market.lastSettleAt(), market.settler(), factory.keeper()]);
    const listings = [];
    if (count > 500n) throw new Error('listing count exceeds read-only baseline limit');
    for (let i = 0; i < Number(count); i++) {
      const token = await market.tokenIndices(i);
      const [listing, request] = await Promise.all([market.listings(token), factory.requests(token)]);
      listings.push({ tokenIndex: Number(token), rented: listing.renter !== ZeroAddress, reserved: listing.reservedFor !== ZeroAddress, ending: listing.ending, returning: listing.returning, stage: Number(request.stage) });
    }
    rows.push({ stack, market: env.MARKET_ADDRESS, count: Number(count), active: listings.filter((v) => v.rented || v.reserved || v.stage > 0), lastSettleAt: Number(lastSettleAt), settler, keeper, listings });
  } catch { rows.push({ stack, error: 'read failed; not a clean baseline' }); }
  finally { provider?.destroy(); }
}
console.log(JSON.stringify({ observedAt: new Date().toISOString(), rows }, null, 2));
