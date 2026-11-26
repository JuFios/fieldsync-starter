import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** Opens a route or controller to requests without a token; every other route requires one. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
