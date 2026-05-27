import type {
  ContractAnswerInput,
  ContractAnswerRecord,
  ContractFieldAnswer,
  ContractQuestion,
  ContractValueEdit
} from "./types.js";

export function materializeContractAnswer(
  question: ContractQuestion,
  answer: ContractAnswerInput
): ContractAnswerRecord {
  const resolution = answer.resolution ?? (answer.fieldEdits || answer.valueEdits ? "edit" : "replace");

  if (resolution === "confirm") {
    if (!question.proposedAnswer) {
      throw new Error(`Contract question '${question.id}' does not provide a proposal to confirm.`);
    }
    return cloneAnswerRecord(question.proposedAnswer, question.id);
  }

  if (resolution === "replace") {
    if (answer.fields) {
      return { questionId: question.id, fields: cloneFields(answer.fields) };
    }
    if (answer.values) {
      return { questionId: question.id, values: [...answer.values] };
    }
    throw new Error(`Contract question '${question.id}' requires replacement fields or values.`);
  }

  if (!question.proposedAnswer) {
    throw new Error(`Contract question '${question.id}' does not provide a proposal to edit.`);
  }

  if (question.expectedAnswerShape.type === "fields") {
    const baseFields = cloneFields(question.proposedAnswer.fields || []);
    return {
      questionId: question.id,
      fields: applyFieldEdits(baseFields, answer)
    };
  }

  return {
    questionId: question.id,
    values: applyValueEdits(question.proposedAnswer.values || [], answer.valueEdits || [])
  };
}

function applyFieldEdits(baseFields: ContractFieldAnswer[], answer: ContractAnswerInput): ContractFieldAnswer[] {
  if (answer.fields) {
    return cloneFields(answer.fields);
  }

  const fields = cloneFields(baseFields);
  for (const edit of answer.fieldEdits || []) {
    const existingIndex = fields.findIndex((field) => field.name === edit.name);
    switch (edit.action) {
      case "add":
        fields.push({
          name: edit.nextName || edit.name,
          type: edit.type || "string",
          ...(edit.required !== undefined ? { required: edit.required } : {}),
          ...(edit.repeated !== undefined ? { repeated: edit.repeated } : {}),
          ...(edit.source ? { source: edit.source } : {})
        });
        break;
      case "remove":
        if (existingIndex >= 0) {
          fields.splice(existingIndex, 1);
        }
        break;
      case "update":
        if (existingIndex < 0) {
          throw new Error(`Cannot update missing proposed field '${edit.name}'.`);
        }
        fields[existingIndex] = {
          ...fields[existingIndex],
          ...(edit.nextName ? { name: edit.nextName } : {}),
          ...(edit.type ? { type: edit.type } : {}),
          ...(edit.required !== undefined ? { required: edit.required } : {}),
          ...(edit.repeated !== undefined ? { repeated: edit.repeated } : {}),
          ...(edit.source ? { source: edit.source } : {})
        };
        break;
    }
  }
  return fields;
}

function applyValueEdits(baseValues: string[], edits: ContractValueEdit[]): string[] {
  const values = [...baseValues];
  for (const edit of edits) {
    const existingIndex = values.indexOf(edit.value);
    if (edit.action === "add" && existingIndex < 0) {
      values.push(edit.value);
    }
    if (edit.action === "remove" && existingIndex >= 0) {
      values.splice(existingIndex, 1);
    }
  }
  return values;
}

function cloneAnswerRecord(record: ContractAnswerRecord, questionId: string): ContractAnswerRecord {
  return {
    questionId,
    ...(record.fields ? { fields: cloneFields(record.fields) } : {}),
    ...(record.values ? { values: [...record.values] } : {})
  };
}

function cloneFields(fields: ContractFieldAnswer[]): ContractFieldAnswer[] {
  return fields.map((field) => ({ ...field }));
}
