const FAMILY_NAMES = ['林', '苏', '江', '夏', '顾', '沈', '陆', '白', '温', '许', '周', '叶'];
const GIVEN_NAMES = ['悠', '晴', '澄', '禾', '远', '星', '川', '榆', '言', '宁', '岚', '秋'];

export function createTemporaryName(random = Math.random) {
  const familyName = FAMILY_NAMES[Math.floor(random() * FAMILY_NAMES.length)];
  const givenName = GIVEN_NAMES[Math.floor(random() * GIVEN_NAMES.length)];
  const suffix = Math.floor(1000 + random() * 9000);
  return `${familyName}${givenName}-${suffix}`;
}
