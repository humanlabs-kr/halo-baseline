import base from '@repo/eslint-config/base';

export default [...base, { ignores: ['out/**', 'cache/**', 'broadcast/**', 'lib/**', 'deployments/**'] }];
