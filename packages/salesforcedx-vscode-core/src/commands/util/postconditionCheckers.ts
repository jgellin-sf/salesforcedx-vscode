/*
 * Copyright (c) 2019, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import {
  CancelResponse,
  ContinueResponse,
  LocalComponent,
  PostconditionChecker
} from '@salesforce/salesforcedx-utils-vscode/out/src/types';
import { existsSync } from 'fs';
import * as path from 'path';
import { ConflictDetector } from '../../conflict/conflictDectionService';
import { ConflictView } from '../../conflict/conflictView';
import { nls } from '../../messages';
import { notificationService } from '../../notifications';
import { telemetryService } from '../../telemetry';
import { getRootWorkspacePath } from '../../util';
import {
  MetadataDictionary,
  MetadataInfo
} from '../../util/metadataDictionary';
import { PathStrategyFactory } from './sourcePathStrategies';

type OneOrMany = LocalComponent | LocalComponent[];
type ContinueOrCancel = ContinueResponse<OneOrMany> | CancelResponse;

export class EmptyPostChecker implements PostconditionChecker<any> {
  public async check(
    inputs: ContinueResponse<any> | CancelResponse
  ): Promise<ContinueResponse<any> | CancelResponse> {
    return inputs;
  }
}

/* tslint:disable-next-line:prefer-for-of */
export class OverwriteComponentPrompt
  implements PostconditionChecker<OneOrMany> {
  public async check(inputs: ContinueOrCancel): Promise<ContinueOrCancel> {
    if (inputs.type === 'CONTINUE') {
      const { data } = inputs;
      // normalize data into a list when processing
      const componentsToCheck = data instanceof Array ? data : [data];
      const foundComponents = componentsToCheck.filter(component =>
        this.componentExists(component)
      );
      if (foundComponents.length > 0) {
        const toSkip = await this.promptOverwrite(foundComponents);
        // cancel command if cancel clicked or if skipping every file to be retrieved
        if (!toSkip || toSkip.size === componentsToCheck.length) {
          return { type: 'CANCEL' };
        }
        if (data instanceof Array) {
          inputs.data = componentsToCheck.filter(
            selection => !toSkip.has(selection)
          );
        }
      }
      return inputs;
    }
    return { type: 'CANCEL' };
  }

  private componentExists(component: LocalComponent) {
    const { fileName, type, outputdir } = component;
    const info = MetadataDictionary.getInfo(type);
    const pathStrategy = info
      ? info.pathStrategy
      : PathStrategyFactory.createDefaultStrategy();
    return this.getFileExtensions(component).some(extension => {
      const filePath = path.join(
        getRootWorkspacePath(),
        pathStrategy.getPathToSource(outputdir, fileName, extension)
      );
      return existsSync(filePath);
    });
  }

  private getFileExtensions(component: LocalComponent) {
    const info = MetadataDictionary.getInfo(component.type);
    let metadataSuffix;
    if (component.suffix) {
      metadataSuffix = component.suffix;
    } else if (info && info.suffix) {
      metadataSuffix = info.suffix;
    } else {
      notificationService.showErrorMessage(
        nls.localize('error_overwrite_prompt')
      );
      telemetryService.sendException(
        'OverwriteComponentPromptException',
        `Missing suffix for ${component.type}`
      );
    }
    const extensions = [`.${metadataSuffix}-meta.xml`];
    if (info && info.extensions) {
      extensions.push(...info.extensions);
    }
    return extensions;
  }

  public async promptOverwrite(
    foundComponents: LocalComponent[]
  ): Promise<Set<LocalComponent> | undefined> {
    const skipped = new Set<LocalComponent>();
    for (let i = 0; i < foundComponents.length; i++) {
      const options = this.buildDialogOptions(foundComponents, skipped, i);
      const choice = await notificationService.showWarningModal(
        this.buildDialogMessage(foundComponents, i),
        ...options
      );
      const othersCount = foundComponents.length - i;
      switch (choice) {
        case nls.localize('warning_prompt_overwrite'):
          break;
        case nls.localize('warning_prompt_skip'):
          skipped.add(foundComponents[i]);
          break;
        case `${nls.localize('warning_prompt_overwrite_all')} (${othersCount})`:
          return skipped;
        case `${nls.localize('warning_prompt_skip_all')} (${othersCount})`:
          return new Set(foundComponents.slice(i));
        default:
          return; // Cancel
      }
    }
    return skipped;
  }

  private buildDialogMessage(
    foundComponents: LocalComponent[],
    currentIndex: number
  ) {
    const existingLength = foundComponents.length;
    const current = foundComponents[currentIndex];
    let body = '';
    for (let j = currentIndex + 1; j < existingLength; j++) {
      // Truncate components to show if there are more than 10 remaining
      if (j === currentIndex + 11) {
        const otherCount = existingLength - currentIndex - 11;
        body += nls.localize('warning_prompt_other_not_shown', otherCount);
        break;
      }
      const { fileName, type } = foundComponents[j];
      body += `${type}:${fileName}\n`;
    }
    const otherFilesCount = existingLength - currentIndex - 1;
    return nls.localize(
      'warning_prompt_overwrite_message',
      current.type,
      current.fileName,
      otherFilesCount > 0
        ? nls.localize('warning_prompt_other_existing', otherFilesCount)
        : '',
      body
    );
  }

  private buildDialogOptions(
    foundComponents: LocalComponent[],
    skipped: Set<LocalComponent>,
    currentIndex: number
  ) {
    const choices = [nls.localize('warning_prompt_overwrite')];
    const numOfExistingFiles = foundComponents.length;
    if (skipped.size > 0 || skipped.size !== numOfExistingFiles - 1) {
      choices.push(nls.localize('warning_prompt_skip'));
    }
    if (currentIndex < numOfExistingFiles - 1) {
      const othersCount = numOfExistingFiles - currentIndex;
      choices.push(
        `${nls.localize('warning_prompt_overwrite_all')} (${othersCount})`,
        `${nls.localize('warning_prompt_skip_all')} (${othersCount})`
      );
    }
    return choices;
  }
}

export class CompositePostconditionChecker<T>
  implements PostconditionChecker<T> {
  private readonly checkers: Array<PostconditionChecker<any>>;
  public constructor(...checkers: Array<PostconditionChecker<any>>) {
    this.checkers = checkers;
  }
  public async check(
    inputs: ContinueResponse<T> | CancelResponse
  ): Promise<CancelResponse | ContinueResponse<T>> {
    const aggregatedData: any = {};
    for (const checker of this.checkers) {
      const input = await checker.check(inputs);
      if (input.type === 'CONTINUE') {
        Object.keys(input.data).map(
          key => (aggregatedData[key] = input.data[key])
        );
      } else {
        return {
          type: 'CANCEL'
        };
      }
    }
    return {
      type: 'CONTINUE',
      data: aggregatedData
    };
  }
}

export class ConflictDetectionChecker
  implements PostconditionChecker<LocalComponent[]> {
  private isManifest: boolean;
  private operation: string;

  public constructor(operation: string, isManifest: boolean) {
    this.operation = operation;
    this.isManifest = isManifest;
  }

  public async check(
    inputs: ContinueResponse<LocalComponent[]> | CancelResponse
  ): Promise<ContinueResponse<LocalComponent[]> | CancelResponse> {
    if (inputs.type === 'CONTINUE') {
      // perform detection for:
      // (1) a single component path
      // (2) a component folder (classes, pages, etc.)
      // (3) application folder
      // (4) a manifest file - complete

      // normalize data
      let data: LocalComponent[] = [];
      let manifest: string | undefined;
      if (Array.isArray(inputs.data)) {
        data = inputs.data;
      } else {
        if (this.isManifest) {
          manifest = String(inputs.data);
        } else {
          data = [this.convertToComponent(String(inputs.data))];
        }
      }

      // TODO: need username and package directory:
      const config = {
        username: 'PdtDevHub2',
        outputdir: 'force-app',
        manifest: manifest,
        components: data
      };
      const checker = new ConflictDetector(false, true);
      const results = await checker.checkForConflicts2(config);

      if (results.different.size === 0) {
        ConflictView.getInstance().reset(config.username, []);
      } else {
        // notificationService.showErrorMessage('Resource Conflicts Detected');
        const choice = await notificationService.showWarningModal(
          'Resource conflicts detected during ' + this.operation,
          'View Conflicts',
          'Force'
        );
        ConflictView.getInstance().reset(
          config.username,
          Array.from(results.different.values())
        );
      }

      if (results.different.size > 0) {
        return { type: 'CANCEL' };
      }

      // short-circuit for now:
      // return inputs;
      return { type: 'CANCEL' };
    }
    return { type: 'CANCEL' };
  }

  private convertToComponent(data: string): LocalComponent {
    const fullBase = path.relative(getRootWorkspacePath(), data);
    const parts = path.parse(fullBase);

    let info: MetadataInfo | undefined;
    if (parts.ext) {
      info = MetadataDictionary.findByExtension(parts.ext);
      if (info) {
        return {
          fileName: parts.name,
          type: info.type,
          outputdir: parts.dir
        } as LocalComponent;
      }
    } else {
      info = MetadataDictionary.findByDirectory(parts.base);
      if (info) {
        return { type: info.type } as LocalComponent;
      }
    }
    return {
      fileName: parts.base,
      outputdir: parts.dir
      // type: 'ApexClass'
    } as LocalComponent;
  }
}

export class ConflictDetectionPostconditionChecker<T>
  implements PostconditionChecker<T> {
  private readonly checkers: Array<PostconditionChecker<any>>;
  public constructor(...checkers: Array<PostconditionChecker<any>>) {
    this.checkers = checkers;
  }
  public async check(
    inputs: ContinueResponse<T> | CancelResponse
  ): Promise<CancelResponse | ContinueResponse<T>> {
    const aggregatedData: any = {};
    for (const checker of this.checkers) {
      const input = await checker.check(inputs);
      if (input.type === 'CONTINUE') {
        Object.keys(input.data).map(
          key => (aggregatedData[key] = input.data[key])
        );
      } else {
        return {
          type: 'CANCEL'
        };
      }
    }
    return {
      type: 'CONTINUE',
      data: aggregatedData
    };
  }
}
