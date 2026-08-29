export const OBELISK_SIGNING_KINDS = [
  0, 1, 3, 4, 5, 6, 7, 9, 13, 14, 1059, 2390,
  9000, 9001, 9002, 9003, 9005, 9007, 9021, 9022, 9734,
  10000, 10002, 10030, 10050, 20078, 22242, 24242,
  25050, 25052, 27235, 30030, 30078,
] as const;

export const OBELISK_NIP46_PERMISSIONS = [
  'nip04_encrypt',
  'nip04_decrypt',
  'nip44_encrypt',
  'nip44_decrypt',
  ...[1, 2, 9, 17, 18, 25, 29, 51, 57, 59, 78, 98].map((nip) => 'nip:' + nip),
  ...[2390, 20078, 22242, 24242, 25050, 25052].map((kind) => 'sign_event:' + kind),
].join(',');
