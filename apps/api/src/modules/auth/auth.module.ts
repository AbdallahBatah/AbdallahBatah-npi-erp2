import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
import { JWT_SECRET } from './jwt.constants';

@Module({
  imports: [
    PassportModule,
    // registerAsync so the secret is read AFTER ConfigModule has loaded .env
    // into process.env — otherwise signing (module import time) and validation
    // (DI time) could resolve different secrets. Both now use JWT_SECRET().
    JwtModule.registerAsync({
      useFactory: () => ({
        secret: JWT_SECRET(),
        signOptions: { expiresIn: process.env.JWT_EXPIRES_IN ?? '12h' },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  exports: [AuthService],
})
export class AuthModule {}
