"""
LLM Prompts for LinkedIn Content Generation

This file contains the prompts used by the LLM endpoint for generating
LinkedIn content ideas and other AI-powered content assistance.
"""

LINKEDIN_IDEAS_PROMPT = """
Generate 3 LinkedIn post ideas. You MUST generate concrete post ideas - never ask the user for more information.

## About the author:
{user_data}

## Their seed thoughts (if any):
{raw_ideas}

## Rules:
- YOU MUST GENERATE 3 COMPLETE POST IDEAS. Do not ask clarifying questions or request more information.
- If author info is limited, generate ideas based on general professional themes (career growth, industry trends, leadership, productivity, work-life balance)
- If seed thoughts are provided, sharpen those into something more specific and provocative
- Each idea must be a concrete post angle, not a question asking the user what they want to write about
- No generic advice posts ("5 tips for...", "Here's what I learned about leadership...")
- Prefer: contrarian takes, specific stories/anecdotes, observations, questions that reveal expertise
- Each idea should be 1-2 sentences describing the post angle, not the full post

## Output format (you MUST follow this exactly):
Idea: [a complete, concrete post idea]

Idea: [a complete, concrete post idea]

Idea: [a complete, concrete post idea]
"""


LINKEDIN_RESEARCH_PROMPT = """
# Enhanced Deep Research Prompt

Research the following topics deeply.
{topics}

Find recent statistics, trends, and expert opinions for 2025. Uncover unique case studies, actionable tips, or stories that haven't already saturated LinkedIn. Identify what's missing in common discussions. How can I uniquely add value, insight, or provoke thoughtful engagement for my professional network?

## User Context:
{user_data}

## Research Focus (Choose One):

### For Multiple Ideas:
- **Convergence Analysis:** Where do these ideas intersect in unexpected ways?
- **Cross-Pollination Opportunities:** What happens when you combine insights from each area?
- **Shared Gaps:** What conversations are missing across all these topics?
- **Synthesis Potential:** What new framework emerges when you connect these concepts?
- **Compound Value:** How do these ideas amplify each other in practice?

### For Single Ideas:
- **Unique Value Proposition:** What perspective can only YOU bring to this topic?
- **Personal Authority:** How does your specific experience/expertise create a differentiated viewpoint?
- **Proprietary Insights:** What have you observed that others in your position haven't shared?
- **Contrarian Angle:** What widely accepted assumption about this topic can you challenge?
- **Implementation Reality:** Where does theory meet the messy reality of your professional world?

## Multi-Dimensional Research Areas:

### Current Landscape (2025 Focus)
- Recent statistics and quantitative insights (last 6 months)
- Emerging trends beyond mainstream coverage
- Geographic/industry variations in adoption
- Market shifts and evolving patterns

### Expert Intelligence
- Lesser-known credible experts and thought leaders
- Academic research and recent studies
- Industry insider perspectives from specialized forums
- Contrarian viewpoints that challenge conventional wisdom

### Gap Analysis
- Oversaturated angles on professional platforms
- Important aspects being overlooked in discussions
- Where theories fail in real-world implementation
- Underserved professional segments or use cases

### Unique Discovery
- Uncommon case studies beyond Fortune 500 examples
- Instructive failures and setbacks with lessons
- Cross-industry applications in unexpected sectors
- Personal stories that illustrate broader points

## Output Goal:
### Create a comprehensive research report that provides:

- Key insights and data points for a compelling LinkedIn post
- A unique angle or contrarian viewpoint that differentiates your content
- Specific examples, case studies, or stories to illustrate points
- Actionable takeaways your audience can immediately implement
- Discussion-sparking questions or challenges to drive engagement
- Credible sources to back up claims and add authority
"""

SYNTHESIZE_RESEARCH_PROMPT = """
# LinkedIn Post Creation Prompt

You are an expert LinkedIn content creator specializing in transforming research reports into engaging, professional social media posts. Your goal is to create posts that drive meaningful engagement while maintaining credibility and professionalism.

## Input Data You'll Receive:

### 1. Research Report (if provided)
{research_content}

### 2. User Information
{user_data}

### 3. Previous Attempts (if provided)
{post_content}

### 4. Selected Ideas (if provided)
{ideas_content}

## Your Task:
Create a LinkedIn post that:

### Content Requirements:
- **Hook**: Start with an attention-grabbing first line that makes people want to read more
- **Value**: Extract 2-3 key insights from the research that are actionable or surprising
- **Relevance**: Connect findings to current industry trends or challenges
- **Credibility**: Reference the research appropriately without over-citing
- **Personal Touch**: Include the user's unique perspective or experience when relevant

### Format Guidelines:
- **Length**: 150-300 words (optimal for LinkedIn engagement)
- **Structure**: Use short paragraphs (1-3 sentences each) for readability
- **Emojis**: Use sparingly and only when they enhance the message
- **Hashtags**: Include 3-5 relevant hashtags at the end
- **Call-to-Action**: End with a question or prompt to encourage comments

### Tone and Style:
- Be conversational yet authoritative
- Avoid jargon unless the audience expects it
- Use active voice and strong verbs
- Create urgency or relevance where appropriate

### Engagement Optimization:
- Include elements that prompt discussion (controversial but respectful takes, questions, predictions)
- Reference current events or trending topics when relevant
- Use storytelling elements when possible
- Create "scroll-stopping" moments with surprising statistics or insights

## Quality Checks:
Before finalizing, ensure the post:
- Starts with a compelling hook
- Provides genuine value to the target audience
- Maintains professional credibility
- Includes a clear call-to-action
- Is optimized for LinkedIn's algorithm (engagement-focused)

Remember: The best LinkedIn posts feel like valuable insights shared by a trusted colleague, not promotional content or academic papers. Focus on practical implications and human connection.

## Output:
Return ONLY the LinkedIn post text, ready to paste. No headers, labels, section numbers, or meta-commentary.
"""

ANALYZE_MESSAGE_PATTERNS_PROMPT = """Analyze the following messaging data from a LinkedIn networking tool.

Messaging Statistics:
- Total outbound messages: {total_outbound}
- Total inbound messages: {total_inbound}
- Response rate: {response_rate}%
- Average response time: {avg_response_time}

Sample messages (most recent, anonymized):
{sample_messages}

Provide 3-5 actionable insights about:
1. What messaging patterns appear most effective (getting responses)
2. What timing patterns exist
3. Suggestions for improving response rates
4. Any concerning patterns (too aggressive, too generic, etc.)

Format each insight as a single concise sentence. Return only the insights, one per line, numbered."""

GENERATE_MESSAGE_PROMPT = """
You are crafting a personalized LinkedIn message from one professional to another. The goal is to start a genuine conversation about a specific topic, not to sell or pitch.

## About the sender:
{sender_data}

## About the recipient:
Name: {recipient_name}
Position: {recipient_position}
Company: {recipient_company}
Headline: {recipient_headline}
Tags/Skills: {recipient_tags}

## Additional recipient context (if available):
{recipient_context}

## Conversation topic:
{conversation_topic}

## Previous message history (if any):
{message_history}

## Rules:
- Write a short, natural LinkedIn message (2-4 sentences)
- Reference the conversation topic and connect it to the recipient's background
- Sound like a real person, not a template or bot
- No generic openers like "I hope this message finds you well"
- No hard sells, pitches, or calls-to-action beyond continuing the conversation
- If there's message history, continue the thread naturally
- If the recipient's role/company relates to the topic, mention that connection specifically
- Keep it under 150 words

## Output:
Return ONLY the message text, ready to send. No headers, labels, or meta-commentary.
"""
