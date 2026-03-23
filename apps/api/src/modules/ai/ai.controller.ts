/*
 * Copyright (c) 2026 Homelab Control Plane contributors
 * SPDX-License-Identifier: MIT
 *
 * This module exposes ai controller request handling for the API service.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import {
  aiChatRequestSchema,
  aiConversationRetentionSchema,
  aiProviderConfigUpdateSchema,
  aiPersonalityUpdateSchema,
  aiUsageRefreshRequestSchema,
  aiUsageTelemetryConfigUpdateSchema,
  aiUsageWindowDaysSchema,
  type AiProviderConfigUpdate,
  type AiChatRequest,
  type AiConversationRetention,
  type AiPersonalityUpdate,
  type AiUsageRefreshRequest,
  type AiUsageTelemetryConfigUpdate,
} from '@homelab/shared';
import type { Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../common/current-user.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AiProviderService } from './ai-provider.service';
import { AiUsageService } from './ai-usage.service';
import { AiService } from './ai.service';

// AI endpoints for chat streaming, host summaries, conversation history, and
// personality settings. All routes require authenticated admin access.
@Controller('ai')
/**
 * Implements the ai controller class.
 */
export class AiController {
  constructor(
    @Inject(AiService) private readonly aiService: AiService,
    @Inject(AiProviderService) private readonly aiProviderService: AiProviderService,
    @Inject(AiUsageService) private readonly aiUsageService: AiUsageService,
  ) {}

  @Post('chat')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async chat(
    @CurrentUser() user: { sub: string },
    @Body(new ZodValidationPipe(aiChatRequestSchema)) body: AiChatRequest,
    @Res() response: Response,
  ) {
    // SSE stream allows incremental token/tracing updates to the UI.
    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache');
    response.setHeader('Connection', 'keep-alive');

    for await (const event of this.aiService.chat(user.sub, body)) {
      response.write(`event: ${event.type}\n`);
      response.write(`data: ${JSON.stringify(event.payload)}\n\n`);
    }

    response.end();
  }

  @Get('status')
  /**
   * Handles status.
   */
  async status() {
    return this.aiService.status();
  }

  @Get('provider')
  /**
   * Handles provider.
   */
  provider() {
    return this.aiProviderService.getProviderConfig();
  }

  @Put('provider')
  setProvider(
    @CurrentUser() user: { sub: string },
    @Body(new ZodValidationPipe(aiProviderConfigUpdateSchema)) body: AiProviderConfigUpdate,
  ) {
    return this.aiProviderService.setProviderConfig(user.sub, body);
  }

  @Get('provider/models')
  providerModels() {
    return this.aiProviderService.listAvailableModels();
  }

  @Get('hosts/:id/summary')
  /**
   * Handles host summary.
   */
  hostSummary(@CurrentUser() user: { sub: string }, @Param('id') id: string) {
    return this.aiService.summarizeHostDetails(id, user.sub);
  }

  @Get('conversations')
  /**
   * Handles list conversations.
   */
  listConversations(@CurrentUser() user: { sub: string }) {
    return this.aiService.listConversations(user.sub);
  }

  @Delete('conversations/:id')
  /**
   * Handles delete conversation.
   */
  deleteConversation(@CurrentUser() user: { sub: string }, @Param('id') id: string) {
    return this.aiService.deleteConversation(user.sub, id);
  }

  @Post('conversations/:id/retention')
  setRetention(
    @CurrentUser() user: { sub: string },
    @Param('id') id: string,
    @Body(new ZodValidationPipe(aiConversationRetentionSchema)) body: AiConversationRetention,
  ) {
    return this.aiService.setRetention(user.sub, id, body.retentionDays);
  }

  @Get('personality')
  /**
   * Handles personality.
   */
  personality(@CurrentUser() user: { sub: string }) {
    return this.aiService.getPersonality(user.sub);
  }

  @Put('personality')
  setPersonality(
    @CurrentUser() user: { sub: string },
    @Body(new ZodValidationPipe(aiPersonalityUpdateSchema)) body: AiPersonalityUpdate,
  ) {
    return this.aiService.setPersonality(user.sub, body.personality);
  }

  @Get('usage-config')
  usageConfig() {
    return this.aiUsageService.getUsageConfig();
  }

  @Put('usage-config')
  setUsageConfig(
    @CurrentUser() user: { sub: string },
    @Body(new ZodValidationPipe(aiUsageTelemetryConfigUpdateSchema))
    body: AiUsageTelemetryConfigUpdate,
  ) {
    return this.aiUsageService.setUsageConfig(user.sub, body);
  }

  @Get('usage-summary')
  usageSummary(@Query('windowDays') windowDays?: string) {
    const parsed = aiUsageWindowDaysSchema.safeParse(
      typeof windowDays === 'string' && windowDays.trim().length > 0
        ? Number(windowDays)
        : 30,
    );
    if (!parsed.success) {
      throw new BadRequestException('windowDays must be one of 7, 30, or 90.');
    }

    return this.aiUsageService.getUsageSummary(parsed.data);
  }

  @Post('usage-refresh')
  refreshUsage(
    @CurrentUser() user: { sub: string },
    @Body(new ZodValidationPipe(aiUsageRefreshRequestSchema)) _body: AiUsageRefreshRequest,
  ) {
    return this.aiUsageService.refreshUsage(user.sub);
  }
}
