import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ItemsService } from './items.service';
import { CreateItemDto, UpdateItemDto } from './dto';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { PERMISSIONS } from '@npi/shared';
import type { AuthUser } from '../../common/auth-user';

@Controller('items')
@UseGuards(PermissionsGuard)
export class ItemsController {
  constructor(private readonly items: ItemsService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.ITEM_READ)
  list(@CurrentUser() user: AuthUser, @Query('search') search?: string) {
    return this.items.list(user, search);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.ITEM_WRITE)
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateItemDto) {
    return this.items.create(user, dto);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.ITEM_WRITE)
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateItemDto,
  ) {
    return this.items.update(user, id, dto);
  }
}
