import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import { ChangePasswordDto, LoginDto } from './dto';
import { Public, CurrentUser, SkipPermissions } from '../../common/decorators';
import type { AuthUser } from '../../common/auth-user';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Tight per-IP limit: bcrypt makes this endpoint both a credential-stuffing
   *  and a CPU-exhaustion target. */
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @Post('login')
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.auth.login(dto, req.ip);
  }

  @SkipPermissions()
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.userId);
  }

  /** Personal, like /me — the caller can only ever change their own password.
   *  Throttled: it verifies the current password with bcrypt (same cost profile
   *  as login). */
  @SkipPermissions()
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @Post('change-password')
  changePassword(
    @CurrentUser() user: AuthUser,
    @Body() dto: ChangePasswordDto,
    @Req() req: Request,
  ) {
    return this.auth.changePassword(user.userId, dto, req.ip);
  }
}
