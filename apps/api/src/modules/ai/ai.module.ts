/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module wires the ai module providers and dependencies.
 */
import { Module } from '@nestjs/common';
import { McpModule } from '../mcp/mcp.module';
import { ToolProposalsModule } from '../tool-proposals/tool-proposals.module';
import { AiProviderService } from './ai-provider.service';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { AiUsageService } from './ai-usage.service';

@Module({
  imports: [McpModule, ToolProposalsModule],
  controllers: [AiController],
  providers: [AiService, AiProviderService, AiUsageService],
  exports: [AiService, AiProviderService, AiUsageService],
})
/**
 * Implements the ai module class.
 */
export class AiModule {}
