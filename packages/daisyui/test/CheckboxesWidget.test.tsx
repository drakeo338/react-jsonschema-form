import type { RJSFSchema } from '@rjsf/utils';
import validator from '@rjsf/validator-ajv8';
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { vi } from 'vitest';

import Form from '../src/index.ts';

const user = userEvent.setup();

const schema: RJSFSchema = {
  type: 'object',
  required: ['choices'],
  properties: {
    choices: { type: 'array', title: 'Choices', items: { type: 'string', enum: ['a', 'b', 'c'] }, uniqueItems: true },
  },
};

describe('CheckboxesWidget', () => {
  // HTML5 constraint validation weighs each box on its own, so a `required` option demands *that* box — every box, for
  // a widget that puts the attribute on all of them. A radio group is the one place the attribute means "one of these",
  // because the browser reads same-named radios as a group; checkboxes share a name without sharing the requirement
  test('lets a required array be submitted with one option checked', async () => {
    const onSubmit = vi.fn();
    const onError = vi.fn();
    const { container } = render(
      <Form
        schema={schema}
        uiSchema={{ choices: { 'ui:widget': 'checkboxes' } }}
        validator={validator}
        onSubmit={onSubmit}
        onError={onError}
      />,
    );

    const boxes = container.querySelectorAll('input[type=checkbox]');
    expect(boxes).toHaveLength(3);
    boxes.forEach((box) => expect(box).not.toHaveAttribute('required'));

    await user.click(boxes[0]);
    await user.click(screen.getByRole('button', { name: 'Submit' }));

    // Constraint validation weighs each box on its own, so the attribute on every one of them asks for all of them:
    // the browser refuses a submit with one checked, and refuses it silently, with neither callback firing
    expect(onError).not.toHaveBeenCalled();
    expect(onSubmit.mock.calls[0]?.[0].formData).toEqual({ choices: ['a'] });
  });
});
