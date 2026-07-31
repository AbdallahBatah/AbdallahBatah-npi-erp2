import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { SearchService } from './search.service';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { CurrentUser, SkipPermissions } from '../../common/decorators';
import type { AuthUser } from '../../common/auth-user';

@Controller('search')
@UseGuards(PermissionsGuard)
export class SearchController {
  constructor(private readonly search: SearchService) {}

  /**
   * @SkipPermissions like /auth/me and the notification feed: there is no
   * single permission to gate an omnisearch on — the service checks each
   * entity's own read permission before querying it.
   */
  @Get()
  @SkipPermissions()
  run(@CurrentUser() user: AuthUser, @Query('q') q?: string) {
    return this.search.search(user, (q ?? '').slice(0, 100));
  }
}
