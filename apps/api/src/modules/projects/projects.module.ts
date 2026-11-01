import { Module } from '@nestjs/common';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { ExecutionController } from './execution.controller';
import { ExecutionService } from './execution.service';

@Module({
  // ExecutionController first: its static segments (`progress/:entryId`,
  // `attendance/:rowId`) never collide with ProjectsController's `:id`, but
  // keeping package 5's routes together reads better.
  controllers: [ExecutionController, ProjectsController],
  providers: [ProjectsService, ExecutionService],
})
export class ProjectsModule {}
