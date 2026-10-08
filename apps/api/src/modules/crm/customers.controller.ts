import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CustomersService } from './customers.service';
import { CustomerContactsService } from './customer-contacts.service';
import { CustomerMergeService } from './customer-merge.service';
import {
  CreateContactDto,
  CreateCustomerDto,
  MergeCustomersDto,
  UpdateContactDto,
  UpdateCustomerDto,
} from './dto';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { PERMISSIONS } from '@npi/shared';
import type { AuthUser } from '../../common/auth-user';

@Controller('customers')
@UseGuards(PermissionsGuard)
export class CustomersController {
  constructor(
    private readonly customers: CustomersService,
    private readonly contacts: CustomerContactsService,
    private readonly merges: CustomerMergeService,
  ) {}

  @Get()
  @RequirePermissions(PERMISSIONS.CUSTOMER_READ)
  list(
    @CurrentUser() user: AuthUser,
    @Query('search') search?: string,
    @Query('includeMerged') includeMerged?: string,
  ) {
    return this.customers.list(user, search, includeMerged === '1' || includeMerged === 'true');
  }

  // The fixed-path routes below MUST stay above `:id`, or `:id` swallows them.

  /** Live "this name looks like…" warning for the create form. */
  @Get('similar')
  @RequirePermissions(PERMISSIONS.CUSTOMER_READ)
  similar(
    @CurrentUser() user: AuthUser,
    @Query('name') name?: string,
    @Query('excludeId') excludeId?: string,
  ) {
    return this.customers.similar(user, name ?? '', excludeId || undefined);
  }

  /** Suggested duplicate groups — a view, never an action. */
  @Get('duplicates')
  @RequirePermissions(PERMISSIONS.CUSTOMER_MERGE)
  duplicates(@CurrentUser() user: AuthUser) {
    return this.merges.duplicates(user);
  }

  @Post('merge')
  @RequirePermissions(PERMISSIONS.CUSTOMER_MERGE)
  merge(@CurrentUser() user: AuthUser, @Body() dto: MergeCustomersDto) {
    return this.merges.merge(user, dto);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.CUSTOMER_READ)
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.customers.get(user, id);
  }

  /** One round trip for the whole customer page. */
  @Get(':id/overview')
  @RequirePermissions(PERMISSIONS.CUSTOMER_READ)
  overview(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.customers.overview(user, id);
  }

  @Get(':id/contacts')
  @RequirePermissions(PERMISSIONS.CUSTOMER_READ)
  listContacts(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.contacts.list(user, id);
  }

  @Post(':id/contacts')
  @RequirePermissions(PERMISSIONS.CUSTOMER_WRITE)
  createContact(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: CreateContactDto,
  ) {
    return this.contacts.create(user, id, dto);
  }

  @Patch(':id/contacts/:contactId')
  @RequirePermissions(PERMISSIONS.CUSTOMER_WRITE)
  updateContact(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('contactId') contactId: string,
    @Body() dto: UpdateContactDto,
  ) {
    return this.contacts.update(user, id, contactId, dto);
  }

  @Delete(':id/contacts/:contactId')
  @RequirePermissions(PERMISSIONS.CUSTOMER_WRITE)
  removeContact(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('contactId') contactId: string,
  ) {
    return this.contacts.remove(user, id, contactId);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.CUSTOMER_WRITE)
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateCustomerDto) {
    return this.customers.create(user, dto);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.CUSTOMER_WRITE)
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateCustomerDto,
  ) {
    return this.customers.update(user, id, dto);
  }
}
