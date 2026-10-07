export class AppError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}

export const CC_SCALE = 100_000_000n;
export const USD_SCALE = 1_000_000n;
export const FIXTURE_RATE = 200_000n;
export const FIXTURE_CC_PER_BYTE = 2_000n;

export function decimal(value: unknown, places: number, max = 1_000_000n): bigint {
  if (typeof value !== 'string' || !/^\d+(\.\d+)?$/.test(value) || value.length > 40) {
    throw new AppError('INVALID_AMOUNT', 'Enter a positive decimal amount without commas or scientific notation.');
  }
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > places) throw new AppError('PRECISION', `Use at most ${places} decimal places.`);
  const scale = 10n ** BigInt(places);
  const amount = BigInt(whole) * scale + BigInt(fraction.padEnd(places, '0'));
  if (amount <= 0n || amount > max * scale) throw new AppError('INVALID_AMOUNT', 'The amount is outside the supported range.');
  return amount;
}

export function format(amount: bigint | string, places: number): string {
  const value = BigInt(amount);
  const scale = 10n ** BigInt(places);
  const fraction = (value % scale).toString().padStart(places, '0').replace(/0+$/, '');
  return `${value / scale}.${fraction.padEnd(2, '0')}`;
}

export function price(cc: bigint, rate = FIXTURE_RATE): bigint {
  return (cc * rate + CC_SCALE / 2n) / CC_SCALE;
}
